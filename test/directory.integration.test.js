// 4단계 완료 기준 검증 (Worker fetch 직접 호출, D1 대신 node:sqlite)
// - 계정을 비활성화하면 디렉터리 표시, 스크립트, 이벤트 4725 가 함께 나온다
// - 이름에 따옴표가 들어가도 스크립트가 깨지지 않는다

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { createFakeD1 } from './helpers/fake-d1.js';

const ADMIN_TOKEN = 'integration-test-admin-token-0123456789';
const { D1, raw } = createFakeD1(fileURLToPath(new URL('../migrations', import.meta.url)));
const env = { DB: D1, ADMIN_TOKEN, UPTIME_MONITOR_BASE_URL: 'https://status-monitor.nalzzoaleph26.workers.dev' };

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const login = async (p) => (await call('/api/demo/login', { method: 'POST', body: { persona: p } })).headers.get('set-cookie').split(';')[0];
const userIdByEmp = (emp) => raw.prepare('SELECT id FROM dir_users WHERE employee_id = ?').get(emp).id;
const op = (cookie, body) => call('/api/directory/operations', { method: 'POST', cookie, body });

let it;
let employee;

test('준비: 초기화로 디렉터리 45계정', async () => {
  const r = await worker.fetch(new Request('http://localhost/api/admin/reset', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), env);
  assert.equal((await r.json()).directoryUsers, 45);
  it = await login('it_admin');
  employee = await login('employee');
});

test('권한: 직원은 디렉터리 API 403', async () => {
  for (const p of ['/api/directory/tree', '/api/directory/users', '/api/directory/meta']) {
    assert.equal((await call(p, { cookie: employee })).status, 403, p);
  }
  assert.equal((await op(employee, { type: 'DISABLE_ACCOUNT', userId: 1 })).status, 403);
});

test('트리: OU 별 인원 (상위 OU 는 하위 합계)', async () => {
  const r = await call('/api/directory/tree', { cookie: it });
  const by = Object.fromEntries(r.body.ous.map((o) => [o.key, o.counts]));
  assert.equal(by.USERS.total, 40);
  assert.equal(by.HQ.total, 20);
  assert.equal(by.SALES.total, 6);
  assert.equal(by.USERS.locked, 2);
  assert.deepEqual([by.FORMER.total, by.FORMER.disabled], [2, 2]);
  assert.equal(by.SERVICE.total, 3);
  assert.equal(by.GROUPS.groups, 15);
});

test('완료 기준: 비활성화 → 디렉터리 표시 + 스크립트(미실행) + 이벤트 4725 가 함께', async () => {
  const id = userIdByEmp('DT-0012');
  const r = await op(it, { type: 'DISABLE_ACCOUNT', userId: id });
  assert.equal(r.status, 201);
  // (1) 디렉터리 상태
  assert.equal(r.body.user.enabled, false);
  assert.deepEqual(r.body.operation.diff, [{ field: 'Enabled', before: true, after: false }]);
  // (2) 스크립트
  assert.equal(r.body.operation.executionStatus, 'NOT_EXECUTED');
  assert.ok(r.body.operation.script.includes('[미실행]'));
  assert.ok(r.body.operation.script.includes(`Disable-ADAccount -Identity '${r.body.user.sam}'`));
  // (3) 이벤트
  assert.deepEqual(r.body.events.map((e) => e.eventId), [4725]);
  assert.equal(r.body.events[0].operationId, r.body.operation.id);
  assert.equal(r.body.events[0].actorSam, raw.prepare("SELECT sam_account_name s FROM dir_users WHERE employee_id = 'DT-0004'").get().s);

  // 디렉터리 목록·상세에도 반영
  const list = await call('/api/directory/users?state=DISABLED&ou=USERS', { cookie: it });
  assert.ok(list.body.users.some((u) => u.id === id));
  const detail = await call(`/api/directory/users/${id}`, { cookie: it });
  assert.equal(detail.body.events[0].eventId, 4725);
  assert.ok(detail.body.availableOperations.includes('ENABLE_ACCOUNT'));
  // 결과 다시 보기
  const again = await call(`/api/directory/operations/${r.body.operation.id}`, { cookie: it });
  assert.equal(again.body.operation.script, r.body.operation.script);

  // 같은 작업 반복은 거부 (스크립트·이벤트 추가 없음)
  const before = raw.prepare('SELECT COUNT(*) c FROM dir_events').get().c;
  assert.equal((await op(it, { type: 'DISABLE_ACCOUNT', userId: id })).body.error.code, 'NO_CHANGE');
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM dir_events').get().c, before);
});

test('실제 AD 와 같은 제약: 비활성 계정은 맞는 비밀번호로도 로그인 불가 (4625, 0xC0000072)', async () => {
  const id = userIdByEmp('DT-0012');
  const r = await call(`/api/directory/users/${id}/logon-test`, { method: 'POST', cookie: it, body: { passwordCorrect: true } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.status, '0xC0000072');
  assert.equal(r.body.detail.events[0].eventId, 4625);
});

test('잠김: 잠긴 계정은 해제 전 로그인 불가 → 잠금 해제(4767) 후 로그인 성공(4624)', async () => {
  const id = userIdByEmp('DT-0022'); // 시드에서 잠김
  let r = await call(`/api/directory/users/${id}/logon-test`, { method: 'POST', cookie: it, body: { passwordCorrect: true } });
  assert.equal(r.body.status, '0xC0000234');
  // 비밀번호 초기화로는 잠금이 풀리지 않는다
  r = await op(it, { type: 'RESET_PASSWORD', userId: id });
  assert.equal(r.body.user.lockedOut, true);
  assert.deepEqual(r.body.events.map((e) => e.eventId), [4724]);
  r = await op(it, { type: 'UNLOCK_ACCOUNT', userId: id });
  assert.deepEqual(r.body.events.map((e) => e.eventId), [4767]);
  r = await call(`/api/directory/users/${id}/logon-test`, { method: 'POST', cookie: it, body: { passwordCorrect: true } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.detail.events[0].eventId, 4624);
});

test('틀린 비밀번호 5회 → 잠김 + 4740 (작업자 SYSTEM)', async () => {
  const id = userIdByEmp('DT-0030');
  let r;
  for (let i = 0; i < 5; i++) r = await call(`/api/directory/users/${id}/logon-test`, { method: 'POST', cookie: it, body: { passwordCorrect: false } });
  assert.equal(r.body.detail.user.lockedOut, true);
  const e4740 = r.body.detail.events.find((e) => e.eventId === 4740);
  assert.equal(e4740.actorSam, 'SYSTEM');
});

test('허용 목록 밖 작업 거부, 그룹 추가·제거·OU 이동', async () => {
  const id = userIdByEmp('DT-0009');
  for (const type of ['DELETE_USER', 'ADD_DOMAIN_ADMIN']) assert.equal((await op(it, { type, userId: id })).body.error.code, 'UNSUPPORTED_OPERATION');

  let r = await op(it, { type: 'ADD_GROUP_MEMBER', userId: id, group: 'GG-FS-Design' });
  assert.equal(r.body.events[0].eventId, 4728);
  assert.equal(r.body.events[0].groupSam, 'GG-FS-Design');
  assert.ok(raw.prepare("SELECT 1 FROM dir_memberships m JOIN dir_groups g ON g.id = m.group_id WHERE m.user_id = ? AND g.sam_account_name = 'GG-FS-Design'").get(id));
  r = await op(it, { type: 'REMOVE_GROUP_MEMBER', userId: id, group: 'GG-FS-Design' });
  assert.equal(r.body.events[0].eventId, 4729);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM dir_memberships m JOIN dir_groups g ON g.id = m.group_id WHERE m.user_id = ? AND g.sam_account_name = 'GG-FS-Design'").get(id).c, 0);

  r = await op(it, { type: 'MOVE_OU', userId: id, ouKey: 'MGMT' });
  assert.equal(r.status, 201);
  assert.ok(r.body.user.dn.includes('OU=경영지원팀'));
  assert.equal(r.body.events[0].eventId, 5139);
  assert.ok(r.body.operation.script.includes('Move-ADObject'));
});

test('계정 생성: 이름 규칙·중복 숫자·이벤트 4건·부서 그룹, 중복 계정명 거부', async () => {
  // DT-0004 강소연과 같은 이름을 다른 부서에 → 계정명은 숫자가 붙는다
  const it4 = raw.prepare("SELECT sam_account_name s, display_name n FROM dir_users WHERE employee_id = 'DT-0004'").get();
  let r = await op(it, { type: 'CREATE_USER', displayName: it4.n, ouKey: 'SALES', title: '사원', employeeId: 'DT-0041' });
  assert.equal(r.status, 201);
  assert.equal(r.body.operation.targetSam, `${it4.s}2`);
  assert.deepEqual(r.body.events.map((e) => e.eventId), [4720, 4724, 4722, 4728]);
  assert.equal(r.body.user.pwdLastSet, null);
  assert.ok(raw.prepare("SELECT 1 FROM dir_memberships m JOIN dir_groups g ON g.id = m.group_id WHERE m.user_id = ? AND g.sam_account_name = 'GG-Dept-Sales'").get(r.body.user.id));

  // 대소문자만 다른 계정명 / 그룹 이름과 같은 계정명 거부
  assert.equal((await op(it, { type: 'CREATE_USER', displayName: '새직원', ouKey: 'SALES', sam: it4.s.toUpperCase() })).body.error.code, 'DUPLICATE_SAM');
  assert.equal((await op(it, { type: 'CREATE_USER', displayName: '새직원', ouKey: 'SALES', sam: 'GG-ERP-Users' })).body.error.code, 'DUPLICATE_SAM');
  // 같은 OU 에 같은 CN
  assert.equal((await op(it, { type: 'CREATE_USER', displayName: it4.n, ouKey: 'SALES' })).body.error.code, 'CN_CONFLICT');
});

test("완료 기준: 이름에 따옴표가 있어도 스크립트가 깨지지 않는다 (생성 → OU 이동까지)", async () => {
  const name = "오'브라이언, 주니어";
  let r = await op(it, { type: 'CREATE_USER', displayName: name, surnameEn: "O'Brien", givenNameEn: 'Sean', ouKey: 'RND' });
  assert.equal(r.status, 201);
  assert.equal(r.body.operation.targetSam, 'sobrien');
  assert.ok(r.body.operation.script.includes("'오''브라이언, 주니어'"));
  // DN 에서는 쉼표가 이스케이프된다
  assert.equal(r.body.user.dn, 'CN=오\'브라이언\\, 주니어,OU=연구개발팀,OU=본사,OU=부서별 사용자,DC=corp,DC=ossan,DC=example');
  r = await op(it, { type: 'MOVE_OU', userId: r.body.user.id, ouKey: 'FORMER' });
  assert.ok(r.body.operation.script.includes("-Identity 'CN=오''브라이언\\, 주니어,OU=연구개발팀"));
  // 줄바꿈이 든 이름은 거부
  assert.equal((await op(it, { type: 'CREATE_USER', displayName: "홍\nRemove-ADUser", ouKey: 'RND' })).body.error.code, 'VALIDATION_FAILED');
});

test('DB 이중 안전장치: 대소문자만 다른 계정명 INSERT 는 DB 가 거부', () => {
  const s = raw.prepare("SELECT sam_account_name s FROM dir_users WHERE employee_id = 'DT-0004'").get().s;
  assert.throws(() =>
    raw
      .prepare("INSERT INTO dir_users (sam_account_name, user_principal_name, distinguished_name, cn, ou_key, display_name, kind, enabled, when_created) VALUES (?, 'x@y', 'CN=x', 'x', 'SALES', 'x', 'PERSON', 1, 'x')")
      .run(s.toUpperCase()),
  );
});
