// 가상 AD 계정 작업 규칙 (순수 함수)
//
// 작업 1건 = (1) 디렉터리 변경 + (2) PowerShell 스크립트(미실행) + (3) 보안 이벤트
// 이 함수는 "무엇을 바꿀지"만 계산한다. 저장은 src/directory.js 가 한 batch 로 한다.
//
// 실제 AD 와 다른 점 (의도적)
// - 이미 비활성인 계정 비활성화처럼 "바뀌는 것이 없는 작업"은 실제 AD 에서는 대부분 오류 없이 넘어가지만,
//   이 시뮬레이터는 의미 없는 스크립트·이벤트가 쌓이지 않게 거부한다(NO_CHANGE).
// - 실제 AD 는 활성화·비활성화 때 4738(계정 변경)도 함께 남기지만, 화면을 단순하게 하려고 기록하지 않는다.

import { DOMAIN, USER_OU_KEYS, getOu, isOuKey, ouDn, userDn, upnOf, deptGroupSam } from './ad-model.js';
import { baseSamFor, uniqueSam, samProblem, textProblem, splitKoreanName } from './ad-naming.js';
import { buildScript } from './ps-script.js';

// 허용 작업 목록. 여기 없는 작업(계정 삭제, 관리자 그룹 추가 등)은 거부한다 = IT 담당자에게 위임된 범위
export const OPERATIONS = Object.freeze({
  CREATE_USER: '계정 생성',
  DISABLE_ACCOUNT: '비활성화',
  ENABLE_ACCOUNT: '활성화',
  RESET_PASSWORD: '비밀번호 초기화',
  UNLOCK_ACCOUNT: '잠금 해제',
  ADD_GROUP_MEMBER: '그룹 추가',
  REMOVE_GROUP_MEMBER: '그룹 제거',
  MOVE_OU: 'OU 이동',
});

export const isOperation = (t) => typeof t === 'string' && Object.hasOwn(OPERATIONS, t);

// Windows 보안 이벤트 ID
export const EVENT_INFO = Object.freeze({
  4624: '계정 로그온 성공',
  4625: '계정 로그온 실패',
  4720: '사용자 계정 생성',
  4722: '사용자 계정 활성화',
  4724: '계정 비밀번호 재설정 시도 (관리자)',
  4725: '사용자 계정 비활성화',
  4728: '보안 전역 그룹에 멤버 추가',
  4729: '보안 전역 그룹에서 멤버 제거',
  4740: '사용자 계정 잠김',
  4767: '사용자 계정 잠금 해제',
  5139: '디렉터리 서비스 개체 이동 (디렉터리 서비스 변경 감사 필요 - 공식 문서 확인 필요)',
});

// 로그온 실패 상태 코드 (4625 의 Sub Status)
export const LOGON_STATUS = Object.freeze({
  '0xC0000072': '계정 비활성',
  '0xC0000234': '계정 잠김',
  '0xC000006A': '잘못된 비밀번호',
});

// 계정 잠금 정책: 5회 틀리면 잠김, 관리자가 해제할 때까지 유지
export const LOCKOUT_POLICY = Object.freeze({ threshold: 5, duration: 'UNTIL_ADMIN_UNLOCK' });

const fail = (httpStatus, code, message, errors) => ({ ok: false, httpStatus, code, message, errors });
const ev = (eventId, extra = {}) => ({ eventId, eventName: EVENT_INFO[eventId], ...extra });

/** 지금 이 사용자에게 할 수 있는 작업 (화면 버튼용) */
export function availableOperations(user, memberOf = []) {
  if (!user) return ['CREATE_USER'];
  const ops = [];
  ops.push(user.enabled ? 'DISABLE_ACCOUNT' : 'ENABLE_ACCOUNT');
  ops.push('RESET_PASSWORD');
  if (user.lockedOut) ops.push('UNLOCK_ACCOUNT');
  ops.push('ADD_GROUP_MEMBER');
  if (memberOf.length) ops.push('REMOVE_GROUP_MEMBER');
  ops.push('MOVE_OU');
  return ops;
}

/**
 * 작업 계획
 * @param {object} input { type, ... } 사용자 입력
 * @param {object} ctx
 *   user: 대상 사용자 (CREATE_USER 는 null)
 *   memberOf: 대상의 그룹 sam 목록
 *   groupSams: 존재하는 그룹 sam 목록
 *   takenSamsLower: Set (사용자+그룹 sam 소문자) — CREATE_USER 용
 *   dnExists: (dn) => boolean — CN 충돌 검사용
 *   now: Date, generatedAtKst: 'YYYY-MM-DD HH:mm'
 * @returns 실패 또는 { ok, type, label, targetSam, newUser?, changes?, addGroups[], removeGroups[], events[], diff[], script, notes[] }
 */
export function planOperation(input, ctx) {
  const type = input?.type;
  if (!isOperation(type)) {
    return fail(400, 'UNSUPPORTED_OPERATION', '허용 목록에 없는 작업입니다 (IT 담당자에게 위임된 범위 밖)');
  }
  if (type === 'CREATE_USER') return planCreate(input, ctx);

  const u = ctx.user;
  if (!u) return fail(404, 'USER_NOT_FOUND', '대상 계정이 없습니다');
  const meta = { label: OPERATIONS[type], generatedAtKst: ctx.generatedAtKst };
  const base = { ok: true, type, label: OPERATIONS[type], targetSam: u.sam, addGroups: [], removeGroups: [], notes: [] };
  const nowIso = ctx.now.toISOString();

  switch (type) {
    case 'DISABLE_ACCOUNT':
      if (!u.enabled) return fail(409, 'NO_CHANGE', '이미 비활성화된 계정입니다');
      return {
        ...base,
        changes: { enabled: 0 },
        diff: [{ field: 'Enabled', before: true, after: false }],
        events: [ev(4725)],
        script: buildScript(type, { sam: u.sam }, meta),
        notes: ['비활성 계정은 로그인할 수 없습니다. 퇴사 처리라면 퇴사자 OU 로 이동도 함께 합니다 (5단계).'],
      };
    case 'ENABLE_ACCOUNT':
      if (u.enabled) return fail(409, 'NO_CHANGE', '이미 활성화된 계정입니다');
      return {
        ...base,
        changes: { enabled: 1 },
        diff: [{ field: 'Enabled', before: false, after: true }],
        events: [ev(4722)],
        script: buildScript(type, { sam: u.sam }, meta),
        notes: u.ouKey === 'FORMER' ? ['퇴사자 OU 에 있는 계정을 활성화했습니다. 의도한 작업인지 확인하세요.'] : [],
      };
    case 'RESET_PASSWORD':
      return {
        ...base,
        changes: { pwd_last_set: null },
        diff: [{ field: 'pwdLastSet', before: u.pwdLastSet ?? '0', after: '0 (다음 로그온 시 변경 필요)' }],
        events: [ev(4724)],
        script: buildScript(type, { sam: u.sam }, meta),
        notes: u.lockedOut ? ['비밀번호를 초기화해도 잠금은 풀리지 않습니다. 잠금 해제를 따로 하세요.'] : [],
      };
    case 'UNLOCK_ACCOUNT':
      if (!u.lockedOut) return fail(409, 'NO_CHANGE', '잠기지 않은 계정입니다');
      return {
        ...base,
        changes: { locked_out: 0, lockout_time: null, bad_pwd_count: 0 },
        diff: [
          { field: 'LockedOut', before: true, after: false },
          { field: 'badPwdCount', before: u.badPwdCount, after: 0 },
        ],
        events: [ev(4767)],
        script: buildScript(type, { sam: u.sam }, meta),
      };
    case 'ADD_GROUP_MEMBER':
    case 'REMOVE_GROUP_MEMBER': {
      const group = input.group;
      if (typeof group !== 'string' || !ctx.groupSams.includes(group)) return fail(400, 'INVALID_GROUP', '그룹을 골라야 합니다');
      const isMember = ctx.memberOf.includes(group);
      if (type === 'ADD_GROUP_MEMBER' && isMember) return fail(409, 'NO_CHANGE', '이미 그 그룹의 멤버입니다');
      if (type === 'REMOVE_GROUP_MEMBER' && !isMember) return fail(409, 'NO_CHANGE', '그 그룹의 멤버가 아닙니다');
      const adding = type === 'ADD_GROUP_MEMBER';
      return {
        ...base,
        changes: {},
        addGroups: adding ? [group] : [],
        removeGroups: adding ? [] : [group],
        diff: [{ field: 'memberOf', before: adding ? '' : group, after: adding ? group : '' }],
        events: [ev(adding ? 4728 : 4729, { groupSam: group })],
        script: buildScript(type, { sam: u.sam, group }, meta),
        notes: ['그룹 변경은 사용자가 다음에 로그인할 때(새 Kerberos 티켓)부터 적용됩니다.'],
      };
    }
    case 'MOVE_OU': {
      const to = input.ouKey;
      if (!isOuKey(to) || !USER_OU_KEYS.includes(to)) return fail(400, 'INVALID_OU', '옮길 OU 를 골라야 합니다');
      if (to === u.ouKey) return fail(409, 'NO_CHANGE', '이미 그 OU 에 있습니다');
      const newDn = userDn(u.cn, to);
      if (ctx.dnExists(newDn)) return fail(409, 'CN_CONFLICT', '대상 OU 에 같은 이름(CN)의 개체가 이미 있습니다');
      return {
        ...base,
        changes: { ou_key: to, distinguished_name: newDn },
        diff: [
          { field: 'OU', before: getOu(u.ouKey).name, after: getOu(to).name },
          { field: 'distinguishedName', before: u.dn, after: newDn },
        ],
        events: [ev(5139, { details: { oldDn: u.dn, newDn } })],
        script: buildScript(type, { sam: u.sam, fromDn: u.dn, toOuDn: ouDn(to) }, meta),
        notes: ['OU 를 옮기면 적용되는 그룹 정책(GPO)이 바뀝니다. 파일 권한은 그룹으로 주므로 바뀌지 않습니다.'],
        nowIso,
      };
    }
    default:
      return fail(400, 'UNSUPPORTED_OPERATION', '허용 목록에 없는 작업입니다');
  }
}

function planCreate(input, ctx) {
  const errors = [];
  const add = (field, message) => message && errors.push({ field, message });
  add('displayName', textProblem(input.displayName, { label: '이름' }));
  add('surnameEn', textProblem(input.surnameEn, { label: '영문 성', max: 30, required: false }));
  add('givenNameEn', textProblem(input.givenNameEn, { label: '영문 이름', max: 30, required: false }));
  add('title', textProblem(input.title, { label: '직급', max: 30, required: false }));
  if (input.employeeId && !/^DT-\d{4}$/.test(input.employeeId)) add('employeeId', '사번 형식은 DT-0000 입니다');
  const ouKey = input.ouKey;
  const ou = getOu(ouKey);
  if (!ou || ou.kind !== 'DEPT') add('ouKey', '부서 OU 를 골라야 합니다');
  if (input.sam !== undefined && input.sam !== null && input.sam !== '') add('sam', samProblem(input.sam));
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);

  const displayName = input.displayName.trim();
  const { surname, givenName } = splitKoreanName(displayName);
  const surnameEn = input.surnameEn?.trim() || null;
  const givenNameEn = input.givenNameEn?.trim() || null;

  let sam;
  if (input.sam) {
    sam = input.sam.trim();
    if (ctx.takenSamsLower.has(sam.toLowerCase())) {
      return fail(409, 'DUPLICATE_SAM', `계정명 ${sam} 은(는) 이미 있습니다 (사용자·그룹 포함, 대소문자 무시)`);
    }
  } else {
    const base = baseSamFor({ surname, givenName, surnameEn, givenNameEn });
    if (!base) return fail(400, 'VALIDATION_FAILED', '영문 이름을 만들 수 없습니다. 영문 성·이름을 입력하세요');
    sam = uniqueSam(base, ctx.takenSamsLower);
  }

  const cn = displayName;
  const dn = userDn(cn, ouKey);
  if (ctx.dnExists(dn)) {
    return fail(409, 'CN_CONFLICT', `${ou.name} OU 에 같은 이름(CN)이 이미 있습니다. 예: "${displayName} (${sam})" 처럼 구분해서 입력하세요`);
  }

  const deptGroup = deptGroupSam(ouKey);
  const nowIso = ctx.now.toISOString();
  const newUser = {
    sam_account_name: sam,
    user_principal_name: upnOf(sam),
    distinguished_name: dn,
    cn,
    ou_key: ouKey,
    given_name: givenName,
    surname,
    display_name: displayName,
    employee_id: input.employeeId || null,
    department: ou.name,
    title: input.title?.trim() || null,
    description: null,
    kind: 'PERSON',
    enabled: 1,
    locked_out: 0,
    lockout_time: null,
    bad_pwd_count: 0,
    pwd_last_set: null, // 0 = 다음 로그온 시 변경
    last_logon: null,
    when_created: nowIso,
  };
  return {
    ok: true,
    type: 'CREATE_USER',
    label: OPERATIONS.CREATE_USER,
    targetSam: sam,
    newUser,
    addGroups: [deptGroup],
    removeGroups: [],
    diff: [
      { field: 'sAMAccountName', before: '', after: sam },
      { field: 'userPrincipalName', before: '', after: newUser.user_principal_name },
      { field: 'distinguishedName', before: '', after: dn },
      { field: 'Enabled', before: '', after: true },
      { field: 'pwdLastSet', before: '', after: '0 (다음 로그온 시 변경 필요)' },
      { field: 'memberOf', before: '', after: deptGroup },
    ],
    // 실제 AD 도 생성 → 비밀번호 설정 → 활성화 과정에서 여러 이벤트를 남긴다 (정확한 순서는 공식 문서 확인 필요)
    events: [ev(4720), ev(4724), ev(4722), ev(4728, { groupSam: deptGroup })],
    script: buildScript(
      'CREATE_USER',
      {
        cn,
        displayName,
        givenName,
        surname,
        sam,
        upn: newUser.user_principal_name,
        ouDn: ouDn(ouKey),
        department: ou.name,
        title: newUser.title,
        employeeId: newUser.employee_id,
        groups: [deptGroup],
      },
      { label: OPERATIONS.CREATE_USER, generatedAtKst: ctx.generatedAtKst },
    ),
    notes: [
      `계정명 규칙: 이름 머리글자 + 성 → ${sam}${input.sam ? ' (직접 입력)' : ''}`,
      '초기 비밀번호는 스크립트에 넣지 않고 실행할 때 입력받습니다. 첫 로그인 때 변경하도록 설정됩니다.',
    ],
  };
}

/**
 * 로그인 시험 (사용자 행동 시뮬레이션. 관리 작업 허용 목록과는 별개)
 * 실제 AD 와 같은 제약: 비활성 계정·잠긴 계정은 비밀번호가 맞아도 로그인 불가
 * @returns {{ success, status?, reason, changes, events }}
 */
export function evaluateLogon(user, { passwordCorrect }, now, policy = LOCKOUT_POLICY) {
  const nowIso = now.toISOString();
  const failEvent = (status) => ev(4625, { details: { status, reason: LOGON_STATUS[status] } });

  if (!user.enabled) {
    return { success: false, status: '0xC0000072', reason: '비활성 계정은 로그인할 수 없습니다', changes: {}, events: [failEvent('0xC0000072')] };
  }
  if (user.lockedOut) {
    return { success: false, status: '0xC0000234', reason: '잠긴 계정은 잠금을 해제하기 전까지 로그인할 수 없습니다', changes: {}, events: [failEvent('0xC0000234')] };
  }
  if (!passwordCorrect) {
    const bad = (user.badPwdCount ?? 0) + 1;
    if (bad >= policy.threshold) {
      return {
        success: false,
        status: '0xC000006A',
        reason: `비밀번호 ${bad}회 실패 → 계정이 잠겼습니다 (정책: ${policy.threshold}회)`,
        changes: { bad_pwd_count: bad, locked_out: 1, lockout_time: nowIso },
        events: [failEvent('0xC000006A'), ev(4740)],
      };
    }
    return {
      success: false,
      status: '0xC000006A',
      reason: `잘못된 비밀번호 (${bad}/${policy.threshold}회)`,
      changes: { bad_pwd_count: bad },
      events: [failEvent('0xC000006A')],
    };
  }
  return {
    success: true,
    reason: user.pwdLastSet ? '로그인 성공' : '로그인 성공 — 비밀번호 변경 필요(pwdLastSet = 0) 상태라 실제로는 변경 화면이 먼저 뜹니다',
    changes: { bad_pwd_count: 0, last_logon: nowIso },
    events: [ev(4624)],
  };
}

export { DOMAIN };
