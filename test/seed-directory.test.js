import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDirectory } from '../src/lib/seed-directory.js';
import { generateSeedData } from '../src/lib/seed-data.js';
import { samProblem } from '../src/lib/ad-naming.js';
import { USER_OU_KEYS, userDn } from '../src/lib/ad-model.js';

const NOW = new Date('2026-11-17T04:30:00+09:00');
const employees = generateSeedData().employees;
const dir = generateDirectory({ employees, now: NOW });

test('계정 45개: 재직자 40 + 퇴사자 2 + 서비스 3, 그룹 15', () => {
  assert.equal(dir.users.length, 45);
  assert.equal(dir.users.filter((u) => u.employee_id && u.ou_key !== 'FORMER').length, 40);
  assert.equal(dir.users.filter((u) => u.ou_key === 'FORMER').length, 2);
  assert.equal(dir.users.filter((u) => u.kind === 'SERVICE').length, 3);
  assert.equal(dir.groups.length, 15);
});

test('재직자마다 사번(employeeID)으로 인사 명단과 1:1 연결', () => {
  const empNos = dir.users.filter((u) => u.ou_key !== 'FORMER' && u.employee_id).map((u) => u.employee_id).sort();
  assert.deepEqual(empNos, employees.map((e) => e.empNo).sort());
});

test('sAMAccountName·UPN·DN 유일 (대소문자 무시), 그룹 이름과도 겹치지 않음, 규칙 위반 없음', () => {
  const lower = (xs) => xs.map((x) => x.toLowerCase());
  const sams = lower([...dir.users.map((u) => u.sam_account_name), ...dir.groups.map((g) => g.sam_account_name)]);
  assert.equal(new Set(sams).size, sams.length);
  assert.equal(new Set(lower(dir.users.map((u) => u.user_principal_name))).size, 45);
  assert.equal(new Set(lower(dir.users.map((u) => u.distinguished_name))).size, 45);
  for (const u of dir.users) {
    assert.equal(samProblem(u.sam_account_name), null, u.sam_account_name);
    assert.ok(USER_OU_KEYS.includes(u.ou_key));
    assert.equal(u.distinguished_name, userDn(u.cn, u.ou_key));
  }
});

test('계정명 규칙: 강소연(IT 담당) → sykang 형태, 영문 소문자·숫자만', () => {
  const it = dir.users.find((u) => u.employee_id === 'DT-0004');
  assert.match(it.sam_account_name, /^[a-z]+[0-9]*$/);
  assert.ok(it.sam_account_name.endsWith('kang'));
});

test('잠긴 계정 2개(4740 기록 있음), 퇴사자는 비활성·그룹 없음, 서비스 계정 1개는 200일 미사용', () => {
  const locked = dir.users.filter((u) => u.locked_out);
  assert.deepEqual(locked.map((u) => u.employee_id).sort(), ['DT-0018', 'DT-0022']);
  for (const u of locked) assert.ok(dir.events.some((e) => e.event_id === 4740 && e.target_user_id === u.id));

  const former = dir.users.filter((u) => u.ou_key === 'FORMER');
  for (const u of former) {
    assert.equal(u.enabled, 0);
    assert.ok(!dir.memberships.some((m) => m.user_id === u.id));
    assert.ok(dir.events.some((e) => e.event_id === 4725 && e.target_user_id === u.id));
  }
  const scan = dir.users.find((u) => u.sam_account_name === 'svc-scan');
  assert.ok(NOW - new Date(scan.last_logon) > 180 * 24 * 3600 * 1000);
});

test('그룹: 재직자 전원 부서 그룹 1개 + ERP, IT 담당 정/부는 헬프데스크 그룹, 중복 가입 없음', () => {
  const key = (m) => `${m.group_id}:${m.user_id}`;
  assert.equal(new Set(dir.memberships.map(key)).size, dir.memberships.length);
  const gid = (sam) => dir.groups.find((g) => g.sam_account_name === sam).id;
  const members = (sam) => dir.memberships.filter((m) => m.group_id === gid(sam)).map((m) => dir.users.find((u) => u.id === m.user_id).employee_id);
  assert.equal(members('GG-ERP-Users').filter(Boolean).length, 40);
  assert.deepEqual(members('GG-IT-Helpdesk').sort(), ['DT-0003', 'DT-0004']);
  const deptGroups = dir.groups.filter((g) => g.kind === 'DEPT').map((g) => g.id);
  for (const u of dir.users.filter((x) => x.ou_key !== 'FORMER' && x.kind === 'PERSON')) {
    assert.equal(dir.memberships.filter((m) => m.user_id === u.id && deptGroups.includes(m.group_id)).length, 1, u.sam_account_name);
  }
});

test('시각은 모두 초기화 시각 이전', () => {
  for (const u of dir.users) {
    for (const k of ['pwd_last_set', 'last_logon', 'lockout_time', 'when_created']) {
      if (u[k]) assert.ok(new Date(u[k]) <= NOW, `${u.sam_account_name}.${k}`);
    }
  }
  for (const e of dir.events) assert.ok(new Date(e.occurred_at) <= NOW);
});
