import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOperation, evaluateLogon, availableOperations, OPERATIONS, LOCKOUT_POLICY } from '../src/lib/ad-operations.js';
import { userDn, GROUPS } from '../src/lib/ad-model.js';

const NOW = new Date('2026-11-11T06:00:00Z');
const user = (o = {}) => ({
  id: 1,
  sam: 'gdhong',
  cn: '홍길동',
  ouKey: 'SALES',
  dn: userDn('홍길동', 'SALES'),
  enabled: true,
  lockedOut: false,
  badPwdCount: 0,
  pwdLastSet: '2026-10-01T00:00:00Z',
  ...o,
});
const ctx = (o = {}) => ({
  user: user(),
  memberOf: ['GG-Dept-Sales', 'GG-ERP-Users'],
  groupSams: GROUPS.map((g) => g.sam),
  takenSamsLower: new Set(['gdhong', ...GROUPS.map((g) => g.sam.toLowerCase())]),
  dnExists: () => false,
  now: NOW,
  generatedAtKst: '2026-11-11 15:00',
  ...o,
});

test('허용 목록 밖 작업은 거부', () => {
  for (const type of ['DELETE_USER', 'ADD_DOMAIN_ADMIN', 'SET_PASSWORD_NEVER_EXPIRES', '__proto__', undefined]) {
    const r = planOperation({ type }, ctx());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNSUPPORTED_OPERATION', String(type));
  }
  assert.equal(Object.keys(OPERATIONS).length, 8);
});

test('완료 기준(규칙): 비활성화 → Enabled false + 스크립트 Disable-ADAccount + 이벤트 4725', () => {
  const r = planOperation({ type: 'DISABLE_ACCOUNT' }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, { enabled: 0 });
  assert.deepEqual(r.events.map((e) => e.eventId), [4725]);
  assert.ok(r.script.includes("Disable-ADAccount -Identity 'gdhong'"));
  assert.ok(r.script.includes('[미실행]'));
  // 이미 비활성이면 거부 (스크립트·이벤트 없음)
  assert.equal(planOperation({ type: 'DISABLE_ACCOUNT' }, ctx({ user: user({ enabled: false }) })).code, 'NO_CHANGE');
});

test('활성화 4722 / 비밀번호 초기화 4724(잠금은 그대로) / 잠금 해제 4767', () => {
  const enable = planOperation({ type: 'ENABLE_ACCOUNT' }, ctx({ user: user({ enabled: false }) }));
  assert.deepEqual(enable.events.map((e) => e.eventId), [4722]);
  assert.equal(planOperation({ type: 'ENABLE_ACCOUNT' }, ctx()).code, 'NO_CHANGE');

  const reset = planOperation({ type: 'RESET_PASSWORD' }, ctx({ user: user({ lockedOut: true }) }));
  assert.deepEqual(reset.changes, { pwd_last_set: null });
  assert.deepEqual(reset.events.map((e) => e.eventId), [4724]);
  assert.ok(reset.notes.some((n) => n.includes('잠금은 풀리지 않습니다')));

  const unlock = planOperation({ type: 'UNLOCK_ACCOUNT' }, ctx({ user: user({ lockedOut: true, badPwdCount: 5 }) }));
  assert.deepEqual(unlock.changes, { locked_out: 0, lockout_time: null, bad_pwd_count: 0 });
  assert.deepEqual(unlock.events.map((e) => e.eventId), [4767]);
  assert.equal(planOperation({ type: 'UNLOCK_ACCOUNT' }, ctx()).code, 'NO_CHANGE');
});

test('그룹 추가 4728 / 제거 4729: 멤버 여부, 없는 그룹', () => {
  const add = planOperation({ type: 'ADD_GROUP_MEMBER', group: 'GG-VPN-Users' }, ctx());
  assert.deepEqual(add.addGroups, ['GG-VPN-Users']);
  assert.deepEqual(add.events, [{ eventId: 4728, eventName: add.events[0].eventName, groupSam: 'GG-VPN-Users' }]);
  assert.equal(planOperation({ type: 'ADD_GROUP_MEMBER', group: 'GG-ERP-Users' }, ctx()).code, 'NO_CHANGE');
  assert.equal(planOperation({ type: 'ADD_GROUP_MEMBER', group: 'Domain Admins' }, ctx()).code, 'INVALID_GROUP');

  const rm = planOperation({ type: 'REMOVE_GROUP_MEMBER', group: 'GG-ERP-Users' }, ctx());
  assert.deepEqual(rm.removeGroups, ['GG-ERP-Users']);
  assert.equal(rm.events[0].eventId, 4729);
  assert.ok(rm.script.includes('-Confirm:$false'));
  assert.equal(planOperation({ type: 'REMOVE_GROUP_MEMBER', group: 'GG-VPN-Users' }, ctx()).code, 'NO_CHANGE');
});

test('OU 이동 5139: DN 이 바뀌고, 같은 OU·CN 충돌·사용자 둘 수 없는 OU 는 거부', () => {
  const r = planOperation({ type: 'MOVE_OU', ouKey: 'FORMER' }, ctx());
  assert.equal(r.changes.distinguished_name, 'CN=홍길동,OU=퇴사자,DC=corp,DC=ossan,DC=example');
  assert.equal(r.events[0].eventId, 5139);
  assert.ok(r.script.includes("Move-ADObject -Identity 'CN=홍길동,OU=영업팀"));
  assert.equal(planOperation({ type: 'MOVE_OU', ouKey: 'SALES' }, ctx()).code, 'NO_CHANGE');
  assert.equal(planOperation({ type: 'MOVE_OU', ouKey: 'HQ' }, ctx()).code, 'INVALID_OU');
  assert.equal(planOperation({ type: 'MOVE_OU', ouKey: 'GROUPS' }, ctx()).code, 'INVALID_OU');
  assert.equal(planOperation({ type: 'MOVE_OU', ouKey: 'FORMER' }, ctx({ dnExists: () => true })).code, 'CN_CONFLICT');
});

test('계정 생성: 이름 규칙·중복 숫자·이벤트 4720/4724/4722/4728·부서 그룹', () => {
  const r = planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES', title: '사원' }, ctx({ user: null }));
  assert.equal(r.ok, true);
  assert.equal(r.targetSam, 'gdhong2'); // gdhong 이 이미 있음
  assert.equal(r.newUser.user_principal_name, 'gdhong2@corp.ossan.example');
  assert.equal(r.newUser.pwd_last_set, null);
  assert.deepEqual(r.addGroups, ['GG-Dept-Sales']);
  assert.deepEqual(r.events.map((e) => e.eventId), [4720, 4724, 4722, 4728]);
  assert.ok(r.script.includes('New-ADUser @newUser'));
  assert.ok(!/password\s*=\s*'/i.test(r.script), '비밀번호 값이 스크립트에 없다');
});

test('계정 생성 거부: 중복 계정명(대소문자·그룹 이름 포함), 금지 문자, CN 충돌, 부서 OU 아님, 줄바꿈', () => {
  const c = ctx({ user: null });
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES', sam: 'GDHONG' }, c).code, 'DUPLICATE_SAM');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES', sam: 'gg-erp-users' }, c).code, 'DUPLICATE_SAM');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES', sam: 'a@b' }, c).code, 'VALIDATION_FAILED');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES', sam: 'x'.repeat(21) }, c).code, 'VALIDATION_FAILED');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'SALES' }, { ...c, dnExists: () => true }).code, 'CN_CONFLICT');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍길동', ouKey: 'FORMER' }, c).code, 'VALIDATION_FAILED');
  assert.equal(planOperation({ type: 'CREATE_USER', displayName: '홍\n길동', ouKey: 'SALES' }, c).code, 'VALIDATION_FAILED');
});

test("계정 생성: 이름에 따옴표가 있어도 스크립트가 깨지지 않는다 (O'Brien → 영문 직접 입력)", () => {
  const r = planOperation(
    { type: 'CREATE_USER', displayName: "오'브라이언", surnameEn: "O'Brien", givenNameEn: 'Sean', ouKey: 'RND' },
    ctx({ user: null }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.targetSam, 'sobrien'); // 계정명에는 영문자·숫자만
  assert.ok(r.script.includes("Name                  = '오''브라이언'"));
  assert.ok(r.newUser.distinguished_name.startsWith("CN=오'브라이언,OU=연구개발팀"));
});

test('로그인 판정: 비활성·잠김은 비밀번호가 맞아도 실패, 5회 실패 → 잠김 + 4740', () => {
  const disabled = evaluateLogon(user({ enabled: false }), { passwordCorrect: true }, NOW);
  assert.equal(disabled.success, false);
  assert.equal(disabled.status, '0xC0000072');
  assert.deepEqual(disabled.events.map((e) => e.eventId), [4625]);

  const locked = evaluateLogon(user({ lockedOut: true }), { passwordCorrect: true }, NOW);
  assert.equal(locked.status, '0xC0000234');

  let u = user();
  for (let i = 1; i < LOCKOUT_POLICY.threshold; i++) {
    const r = evaluateLogon(u, { passwordCorrect: false }, NOW);
    assert.deepEqual(r.events.map((e) => e.eventId), [4625]);
    u = { ...u, badPwdCount: r.changes.bad_pwd_count };
  }
  const fifth = evaluateLogon(u, { passwordCorrect: false }, NOW);
  assert.deepEqual(fifth.events.map((e) => e.eventId), [4625, 4740]);
  assert.equal(fifth.changes.locked_out, 1);

  const ok = evaluateLogon(user({ badPwdCount: 3 }), { passwordCorrect: true }, NOW);
  assert.equal(ok.success, true);
  assert.deepEqual(ok.changes, { bad_pwd_count: 0, last_logon: NOW.toISOString() });
  assert.deepEqual(ok.events.map((e) => e.eventId), [4624]);
});

test('가능한 작업 목록', () => {
  assert.deepEqual(availableOperations(user(), ['GG-Dept-Sales']), ['DISABLE_ACCOUNT', 'RESET_PASSWORD', 'ADD_GROUP_MEMBER', 'REMOVE_GROUP_MEMBER', 'MOVE_OU']);
  assert.ok(availableOperations(user({ enabled: false, lockedOut: true }), []).includes('UNLOCK_ACCOUNT'));
  assert.ok(availableOperations(user({ enabled: false }), []).includes('ENABLE_ACCOUNT'));
});
