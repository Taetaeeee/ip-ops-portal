// 가상 AD 디렉터리 시드 (순수 함수)
// - 재직자 40명: 부서 OU, 부서 그룹 + 업무 그룹
// - 잠긴 계정 2개 (2단계 데모 티켓 "ERP 계정 잠김", "그룹웨어 비밀번호 만료 후 로그인 불가"와 연결)
// - 퇴사자 OU 비활성 계정 2개 (인사 명단에 없음 → 5단계 대조 재료)
// - 서비스 계정 3개 (그중 1개는 오래 로그인 안 함 → 7단계 점검 재료)
// 시각은 초기화 시각(now) 기준 상대 시각. 이름은 모두 가상이다.

import { createRng, DEPARTMENTS, PERSONA_EMP_NO, IT_BACKUP_EMP_NO } from './seed-data.js';
import { GROUPS, groupDn, userDn, upnOf, deptGroupSam } from './ad-model.js';
import { baseSamFor, uniqueSam, splitKoreanName } from './ad-naming.js';
import { EVENT_INFO } from './ad-operations.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// 업무 그룹 멤버 (사번 또는 부서 코드)
const ROLE_MEMBERS = {
  'GG-ERP-Purchase': { depts: ['PURCH'], empNos: ['DT-0038'] },
  'GG-FS-Design': { depts: ['RND'], empNos: ['DT-0021'] },
  'GG-FS-Material': { depts: ['LOGI'], empNos: ['DT-0014'] },
  'GG-VPN-Users': { depts: ['EXEC', 'SALES'], empNos: [PERSONA_EMP_NO.it_admin, IT_BACKUP_EMP_NO] },
  'GG-IT-Helpdesk': { depts: [], empNos: [PERSONA_EMP_NO.it_admin, IT_BACKUP_EMP_NO] },
};

// 잠긴 계정: 사번 → 잠긴 지 몇 시간 전
const LOCKED = { 'DT-0022': 3, 'DT-0018': 26 };

const FORMER = [
  { name: '배지훈', employeeId: 'DT-9001', dept: 'SALES', title: '대리', leftOn: '2025-05-30', hiredOn: '2019-03-04' },
  { name: '노하린', employeeId: 'DT-9002', dept: 'PROD', title: '사원', leftOn: '2025-09-30', hiredOn: '2023-01-02' },
];

const SERVICES = [
  { sam: 'svc-erp-sync', display: 'ERP 데이터 동기화 서비스', description: 'ERP ↔ 그룹웨어 조직도 동기화 (비밀번호 만료 없음 설정)', lastLogonAgo: 10 * 60 * 1000, groups: ['GG-ERP-Users'] },
  { sam: 'svc-backup', display: '백업 서비스', description: '파일 서버 → 백업 NAS 야간 백업', lastLogonAgo: 6 * HOUR, groups: [] },
  { sam: 'svc-scan', display: '복합기 스캔 저장', description: '복합기 스캔 → 공유 폴더 저장 (구형 복합기 교체 후 미사용 추정)', lastLogonAgo: 200 * DAY, groups: [] },
];

const kst0900 = (ymd) => `${ymd}T00:00:00.000Z`;

/**
 * @param {{employees: object[], now: Date, seed?: number}} p
 */
export function generateDirectory({ employees, now, seed = 4040 }) {
  const rng = createRng(seed);
  const t = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  const deptName = Object.fromEntries(DEPARTMENTS.map((d) => [d.code, d.name]));

  const groups = GROUPS.map((g, i) => ({
    id: i + 1,
    sam_account_name: g.sam,
    cn: g.sam,
    distinguished_name: groupDn(g.sam),
    group_scope: 'Global',
    group_category: 'Security',
    kind: g.kind,
    description: g.description,
  }));
  const groupId = Object.fromEntries(groups.map((g) => [g.sam_account_name, g.id]));
  const taken = new Set(groups.map((g) => g.sam_account_name.toLowerCase()));

  const users = [];
  const addUser = (u) => {
    const row = { id: users.length + 1, version: 1, ...u };
    users.push(row);
    taken.add(row.sam_account_name.toLowerCase());
    return row;
  };

  // 1) 재직자 40명
  for (const e of employees) {
    const { surname, givenName } = splitKoreanName(e.name);
    const sam = uniqueSam(baseSamFor({ surname, givenName }), taken);
    const lockedHours = LOCKED[e.empNo];
    addUser({
      sam_account_name: sam,
      user_principal_name: upnOf(sam),
      distinguished_name: userDn(e.name, e.deptCode),
      cn: e.name,
      ou_key: e.deptCode,
      given_name: givenName,
      surname,
      display_name: e.name,
      employee_id: e.empNo,
      department: deptName[e.deptCode],
      title: e.jobTitle,
      description: e.duty ?? null,
      kind: 'PERSON',
      enabled: 1,
      locked_out: lockedHours ? 1 : 0,
      lockout_time: lockedHours ? t(lockedHours * HOUR) : null,
      bad_pwd_count: lockedHours ? 5 : 0,
      pwd_last_set: t((10 + Math.floor(rng() * 70)) * DAY),
      last_logon: t((lockedHours ?? 0) * HOUR + (1 + Math.floor(rng() * 60)) * HOUR),
      when_created: kst0900(e.hireDate),
      _empNo: e.empNo,
      _dept: e.deptCode,
    });
  }

  // 2) 퇴사자 (비활성, 퇴사자 OU, 그룹 없음)
  for (const f of FORMER) {
    const { surname, givenName } = splitKoreanName(f.name);
    const sam = uniqueSam(baseSamFor({ surname, givenName }), taken);
    addUser({
      sam_account_name: sam,
      user_principal_name: upnOf(sam),
      distinguished_name: userDn(f.name, 'FORMER'),
      cn: f.name,
      ou_key: 'FORMER',
      given_name: givenName,
      surname,
      display_name: f.name,
      employee_id: f.employeeId,
      department: deptName[f.dept],
      title: f.title,
      description: `${f.leftOn} 퇴사`,
      kind: 'PERSON',
      enabled: 0,
      locked_out: 0,
      lockout_time: null,
      bad_pwd_count: 0,
      pwd_last_set: kst0900('2025-01-06'),
      last_logon: `${f.leftOn}T08:40:00.000Z`,
      when_created: kst0900(f.hiredOn),
      _leftOn: f.leftOn,
    });
  }

  // 3) 서비스 계정
  for (const s of SERVICES) {
    addUser({
      sam_account_name: s.sam,
      user_principal_name: upnOf(s.sam),
      distinguished_name: userDn(s.sam, 'SERVICE'),
      cn: s.sam,
      ou_key: 'SERVICE',
      given_name: null,
      surname: null,
      display_name: s.display,
      employee_id: null,
      department: null,
      title: null,
      description: s.description,
      kind: 'SERVICE',
      enabled: 1,
      locked_out: 0,
      lockout_time: null,
      bad_pwd_count: 0,
      pwd_last_set: t(400 * DAY),
      last_logon: t(s.lastLogonAgo),
      when_created: kst0900('2021-03-15'),
      _groups: s.groups,
    });
  }

  // 멤버십
  const memberships = [];
  const join = (u, sam) => memberships.push({ group_id: groupId[sam], user_id: u.id, added_at: u.when_created });
  for (const u of users) {
    if (u._empNo) {
      join(u, deptGroupSam(u._dept));
      join(u, 'GG-ERP-Users');
      for (const [sam, rule] of Object.entries(ROLE_MEMBERS)) {
        if (rule.depts.includes(u._dept) || rule.empNos.includes(u._empNo)) join(u, sam);
      }
    }
    for (const sam of u._groups ?? []) join(u, sam);
  }

  // 이벤트 (과거 기록 몇 건)
  const bySam = (empNo) => users.find((u) => u._empNo === empNo);
  const itSam = bySam(PERSONA_EMP_NO.it_admin).sam_account_name;
  const events = [];
  const event = (eventId, u, occurredAt, extra = {}) =>
    events.push({
      event_id: eventId,
      event_name: EVENT_INFO[eventId],
      occurred_at: occurredAt,
      target_user_id: u.id,
      target_sam: u.sam_account_name,
      group_sam: extra.group ?? null,
      actor_sam: extra.actor ?? itSam,
      operation_id: null,
      details: extra.details ? JSON.stringify(extra.details) : null,
    });

  for (const [empNo, hours] of Object.entries(LOCKED)) {
    const u = bySam(empNo);
    event(4740, u, u.lockout_time, { actor: 'SYSTEM', details: { reason: '비밀번호 5회 실패', callerComputer: '(가상) 사용자 PC' } });
  }
  const unlocked = bySam('DT-0010'); // 완료 티켓 "출근 후 PC 로그인 불가 (계정 잠김)"
  event(4740, unlocked, t(5 * DAY + 2 * HOUR), { actor: 'SYSTEM', details: { reason: '비밀번호 5회 실패' } });
  event(4767, unlocked, t(5 * DAY));
  const material = bySam('DT-0038'); // 완료 티켓 "공유 폴더 자재 쓰기 권한 요청"
  event(4728, material, t(9 * DAY), { group: 'GG-FS-Material' });
  for (const u of users.filter((x) => x._leftOn)) event(4725, u, `${u._leftOn}T09:00:00.000Z`);
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  // 내부용 필드 제거
  const clean = users.map(({ _empNo, _dept, _leftOn, _groups, ...rest }) => rest);
  return { groups, users: clean, memberships, events };
}
