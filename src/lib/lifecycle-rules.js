// 입·퇴사 워크플로 규칙 (순수 함수)
// - 체크리스트 템플릿과 "선행 항목" 순서 규칙
// - 재직 상태 계산 (입사 예정 / 재직 / 퇴사일 당일 / 퇴사)
// - 미처리 퇴사자 계정 검출
//
// 순서는 한 줄로 세우지 않고 "선행 항목 목록"으로 정한다.
// 서로 독립적인 일(예: 계정 비활성화와 백업 확인)은 동시에 진행할 수 있다.

export const CASE_TYPES = Object.freeze({ ONBOARDING: '입사', OFFBOARDING: '퇴사' });
export const ITEM_KINDS = Object.freeze({ DIRECTORY: '디렉터리', ASSET: '자산', LICENSE: '라이선스', MANUAL: '수동 확인' });

export const CHECKLISTS = Object.freeze({
  ONBOARDING: Object.freeze([
    { key: 'CREATE_ACCOUNT', title: '계정 생성', kind: 'DIRECTORY', requires: [] },
    { key: 'ADD_ROLE_GROUPS', title: '부서 그룹 추가', kind: 'DIRECTORY', requires: ['CREATE_ACCOUNT'] },
    { key: 'ISSUE_DEVICE', title: '장비 지급', kind: 'ASSET', requires: [] },
    { key: 'ASSIGN_SOFTWARE', title: '소프트웨어 배정', kind: 'LICENSE', requires: ['ISSUE_DEVICE'] },
    { key: 'USER_GUIDE', title: '사용자 안내', kind: 'MANUAL', requires: ['ADD_ROLE_GROUPS', 'ASSIGN_SOFTWARE'] },
  ]),
  OFFBOARDING: Object.freeze([
    // 보안상 가장 먼저: 퇴사일 업무가 끝나면 즉시 로그인 차단
    { key: 'DISABLE_ACCOUNT', title: '계정 비활성화', kind: 'DIRECTORY', requires: [] },
    // 실수로 다시 활성화돼도 권한이 없도록 그룹 제거 (제거 목록은 기록 → 복직 대비)
    { key: 'REMOVE_GROUPS', title: '그룹 제거', kind: 'DIRECTORY', requires: ['DISABLE_ACCOUNT'] },
    { key: 'MOVE_TO_FORMER_OU', title: '퇴사자 OU 이동', kind: 'DIRECTORY', requires: ['REMOVE_GROUPS'] },
    // 백업 확인은 계정 작업과 독립. 단, 장비 반납(초기화) 전에는 반드시 끝나야 한다
    { key: 'CONFIRM_BACKUP', title: '업무 데이터 백업 확인', kind: 'MANUAL', requires: [] },
    { key: 'RETURN_DEVICES', title: '장비 반납', kind: 'ASSET', requires: ['CONFIRM_BACKUP'] },
    // 반납된 PC 에 남은 유료 SW 를 지워야 라이선스가 돌아온다 (3단계: 재고 PC 도 라이선스를 쓴다)
    { key: 'RECLAIM_LICENSES', title: '라이선스 회수', kind: 'LICENSE', requires: ['RETURN_DEVICES'] },
  ]),
});

// 메모가 꼭 필요한 수동 항목
export const NOTE_REQUIRED = Object.freeze({
  CONFIRM_BACKUP: '백업 위치와 인수자를 적어야 합니다',
  USER_GUIDE: '안내한 내용(계정명 전달, 초기 비밀번호 전달 방법 등)을 적어야 합니다',
});

/**
 * 케이스의 체크리스트 항목 만들기
 * @param {'ONBOARDING'|'OFFBOARDING'} caseType
 * @param {{itAssignee: string, deptLead?: string}} who 담당자 기본값 (백업 확인만 부서 팀장)
 */
export function buildChecklist(caseType, { itAssignee, deptLead }) {
  const template = CHECKLISTS[caseType];
  if (!template) throw new RangeError(`알 수 없는 케이스 종류: ${caseType}`);
  return template.map((t, i) => ({
    seq: i + 1,
    itemKey: t.key,
    title: t.title,
    kind: t.kind,
    requires: [...t.requires],
    status: 'PENDING',
    assigneeEmpNo: t.key === 'CONFIRM_BACKUP' && deptLead ? deptLead : itAssignee,
  }));
}

/** 항목별 상태: DONE / READY(실행 가능) / BLOCKED(선행 미완료) */
export function itemStates(items) {
  const byKey = new Map(items.map((i) => [i.itemKey, i]));
  return items.map((i) => {
    if (i.status === 'DONE') return { ...i, state: 'DONE', blockedBy: [] };
    const blockedBy = (i.requires ?? []).map((k) => byKey.get(k)).filter((r) => r && r.status !== 'DONE');
    return { ...i, state: blockedBy.length ? 'BLOCKED' : 'READY', blockedBy: blockedBy.map((r) => r.title) };
  });
}

/**
 * 항목을 지금 실행할 수 있는지. 문제가 없으면 null.
 * @param {object} item
 * @param {object[]} items 같은 케이스의 모든 항목
 * @param {{caseStatus, caseType, effectiveDate, todayKst}} ctx
 */
export function executionProblem(item, items, ctx) {
  const fail = (httpStatus, code, message) => ({ httpStatus, code, message });
  if (ctx.caseStatus !== 'OPEN') return fail(409, 'CASE_CLOSED', '완료된 케이스입니다');
  if (!item) return fail(404, 'ITEM_NOT_FOUND', '없는 항목입니다');
  if (item.status === 'DONE') return fail(409, 'ALREADY_DONE', '이미 완료된 항목입니다');
  const state = itemStates(items).find((i) => i.itemKey === item.itemKey);
  if (state.state === 'BLOCKED') {
    return fail(409, 'BLOCKED', `앞 항목(${state.blockedBy.join(', ')})을 먼저 완료해야 합니다`);
  }
  // 퇴사일 전에는 계정을 막지 않는다 (마지막 근무일까지 일해야 하므로).
  // 즉시 차단이 필요하면 디렉터리 화면에서 직접 비활성화 → 이 항목은 "이미 비활성 확인"으로 완료된다.
  if (ctx.caseType === 'OFFBOARDING' && item.itemKey === 'DISABLE_ACCOUNT' && ctx.todayKst < ctx.effectiveDate) {
    return fail(409, 'TOO_EARLY', `퇴사일(${ctx.effectiveDate}) 전에는 체크리스트에서 비활성화할 수 없습니다`);
  }
  return null;
}

export const isCaseComplete = (items) => items.length > 0 && items.every((i) => i.status === 'DONE');

/**
 * 인사 기준 재직 상태 (날짜는 KST 'YYYY-MM-DD')
 * - UPCOMING: 입사일 전   - ACTIVE: 재직   - LAST_DAY: 퇴사일 당일(근무일)   - RESIGNED: 퇴사일 다음 날부터
 */
export function employmentStatus({ hireDate, resignDate }, todayKst) {
  if (hireDate && hireDate > todayKst) return 'UPCOMING';
  if (resignDate) {
    if (resignDate < todayKst) return 'RESIGNED';
    if (resignDate === todayKst) return 'LAST_DAY';
  }
  return 'ACTIVE';
}

/**
 * 미처리 퇴사자 계정: 퇴사일이 지났는데(다음 날부터) AD 계정이 아직 활성
 * @param {{employees: {empNo, name, resignDate}[], dirUsers: {id, sam, employeeId, enabled}[], openCases: {id, empNo, caseType}[], todayKst: string}} p
 */
export function detectUnprocessedLeavers({ employees, dirUsers, openCases = [], todayKst }) {
  const DAY = 86400000;
  const out = [];
  for (const e of employees) {
    if (!e.resignDate || !(e.resignDate < todayKst)) continue;
    const accounts = dirUsers.filter((u) => u.employeeId === e.empNo && u.enabled);
    if (!accounts.length) continue;
    const c = openCases.find((x) => x.empNo === e.empNo && x.caseType === 'OFFBOARDING');
    out.push({
      empNo: e.empNo,
      name: e.name,
      resignDate: e.resignDate,
      daysOverdue: Math.round((Date.parse(todayKst) - Date.parse(e.resignDate)) / DAY),
      accounts: accounts.map((a) => ({ id: a.id, sam: a.sam })),
      caseId: c?.id ?? null,
    });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue || a.empNo.localeCompare(b.empNo));
}
