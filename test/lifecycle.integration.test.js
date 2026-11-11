// 5단계 완료 기준 검증: "퇴사 처리를 끝까지 진행하면 디렉터리·자산·라이선스가 모두 바뀌고 이력이 남는다"
// Worker fetch 직접 호출 (D1 대신 node:sqlite)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { createFakeD1 } from './helpers/fake-d1.js';
import { kstToday, addDays } from '../src/lib/license-reconcile.js';

const ADMIN_TOKEN = 'integration-test-admin-token-0123456789';
const { D1, raw } = createFakeD1(fileURLToPath(new URL('../migrations', import.meta.url)));
const env = { DB: D1, ADMIN_TOKEN, UPTIME_MONITOR_BASE_URL: 'https://status-monitor.nalzzoaleph26.workers.dev' };
const TODAY = kstToday(new Date());

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const login = async (p) => (await call('/api/demo/login', { method: 'POST', body: { persona: p } })).headers.get('set-cookie').split(';')[0];

let it;
let employee;
const exec = (caseId, itemKey, body = {}) => {
  const itemId = raw.prepare('SELECT id FROM checklist_items WHERE case_id = ? AND item_key = ?').get(caseId, itemKey).id;
  return call(`/api/lifecycle/cases/${caseId}/items/${itemId}/execute`, { method: 'POST', cookie: it, body });
};
const license = async (name) => (await call('/api/licenses', { cookie: it })).body.licenses.find((l) => l.productName === name);

test('준비: 초기화 → 직원 41(입사 예정 1 포함), 케이스 2', async () => {
  const r = await worker.fetch(new Request('http://localhost/api/admin/reset', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), env);
  const body = await r.json();
  assert.equal(body.employees, 41);
  assert.equal(body.lifecycleCases, 2);
  it = await login('it_admin');
  employee = await login('employee');
});

test('권한: 직원은 입·퇴사 API 403', async () => {
  assert.equal((await call('/api/lifecycle/cases', { cookie: employee })).status, 403);
});

test('미처리 퇴사자 경고: 퇴사일 3일 지났는데 계정 활성 (케이스 없음)', async () => {
  const r = await call('/api/lifecycle/cases', { cookie: it });
  assert.equal(r.body.warnings.length, 1);
  const w = r.body.warnings[0];
  assert.equal(w.empNo, 'DT-0036');
  assert.equal(w.daysOverdue, 3);
  assert.equal(w.caseId, null);
  assert.equal(w.accounts.length, 1);
  // 진행 중 퇴사 대상자(DT-0016)는 퇴사일 당일이라 경고 없음
  assert.ok(!r.body.warnings.some((x) => x.empNo === 'DT-0016'));
});

test('회사 개요: 재직자 기준 (퇴사 1 제외, 입사 예정 1 별도)', async () => {
  const r = await call('/api/org/summary', { cookie: it });
  assert.equal(r.body.totalHeadcount, 39);
  assert.equal(r.body.resigned, 1);
  assert.equal(r.body.upcomingHires, 1);
});

let before;
test('퇴사 순서 규칙: 앞 항목 전에는 실행 불가 (409)', async () => {
  const d = (await call('/api/lifecycle/cases/1', { cookie: it })).body;
  assert.deepEqual(d.items.filter((i) => i.state === 'READY').map((i) => i.itemKey), ['DISABLE_ACCOUNT', 'CONFIRM_BACKUP']);
  for (const key of ['REMOVE_GROUPS', 'MOVE_TO_FORMER_OU', 'RETURN_DEVICES', 'RECLAIM_LICENSES']) {
    const r = await exec(1, key);
    assert.equal(r.status, 409, key);
    assert.equal(r.body.error.code, 'BLOCKED', key);
  }
  before = {
    office: (await license('오피스 제품군')).installed,
    hangul: (await license('한글 워드프로세서')).installed,
    account: d.account,
    devices: d.devices,
  };
  assert.equal(before.account.enabled, true);
  assert.equal(before.account.groups.length, 3); // 부서 + ERP + ERP 구매
  assert.equal(before.devices.length, 1);
});

test('완료 기준: 퇴사 6항목을 끝까지 → 디렉터리·자산·라이선스가 바뀌고 이력이 남는다', async () => {
  // 1) 계정 비활성화
  let r = await exec(1, 'DISABLE_ACCOUNT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let item = r.body.detail.items.find((i) => i.itemKey === 'DISABLE_ACCOUNT');
  assert.equal(item.links[0].operation.type, 'DISABLE_ACCOUNT');
  assert.deepEqual(item.links[0].operation.eventIds, [4725]);

  // 2) 그룹 제거 (3개 → 각각 작업·4729)
  r = await exec(1, 'REMOVE_GROUPS');
  item = r.body.detail.items.find((i) => i.itemKey === 'REMOVE_GROUPS');
  assert.equal(item.links.length, 3);
  assert.ok(item.links.every((l) => l.operation.eventIds[0] === 4729));
  assert.deepEqual(item.links.map((l) => l.detail.group).sort(), [...before.account.groups].sort());

  // 3) 퇴사자 OU 이동
  r = await exec(1, 'MOVE_TO_FORMER_OU');
  assert.equal(r.body.detail.account.ouPath, '퇴사자');

  // 4) 백업 확인: 메모 없으면 거부
  assert.equal((await exec(1, 'CONFIRM_BACKUP')).body.error.code, 'NOTE_REQUIRED');
  r = await exec(1, 'CONFIRM_BACKUP', { note: '\\\\fileserver\\구매\\인수인계 로 이동, 인수자 구매팀장' });
  assert.equal(r.status, 200);

  // 5) 장비 반납
  r = await exec(1, 'RETURN_DEVICES');
  assert.equal(r.body.detail.devices.length, 0);

  // 6) 라이선스 회수
  r = await exec(1, 'RECLAIM_LICENSES');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.detail.case.status, 'COMPLETED');

  // ── 디렉터리 ──
  const acct = raw.prepare('SELECT * FROM dir_users WHERE id = ?').get(before.account.id);
  assert.equal(acct.enabled, 0);
  assert.equal(acct.ou_key, 'FORMER');
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM dir_memberships WHERE user_id = ?').get(acct.id).c, 0);

  // ── 자산 ──
  const deviceId = before.devices[0].id;
  assert.equal(raw.prepare('SELECT status FROM assets WHERE id = ?').get(deviceId).status, 'IN_STOCK');
  const asg = raw.prepare("SELECT * FROM asset_assignments WHERE asset_id = ? AND emp_no = 'DT-0016'").get(deviceId);
  assert.ok(asg.returned_at);
  assert.equal(asg.return_condition, 'IN_STOCK');

  // ── 라이선스 ──
  assert.equal((await license('오피스 제품군')).installed, before.office - 1);
  assert.equal((await license('한글 워드프로세서')).installed, before.hangul - 1);
  const leftSw = raw.prepare('SELECT software_name FROM asset_software WHERE asset_id = ?').all(deviceId).map((s) => s.software_name);
  assert.ok(!leftSw.some((s) => s.startsWith('오피스') || s.startsWith('한글') || s.startsWith('엔드포인트')));

  // ── 이력 ──
  const events = raw.prepare('SELECT event_id FROM dir_events WHERE target_user_id = ? AND operation_id IS NOT NULL ORDER BY id').all(acct.id).map((e) => e.event_id);
  assert.deepEqual(events, [4725, 4729, 4729, 4729, 5139]);
  assert.equal(raw.prepare('SELECT COUNT(*) c FROM dir_operations WHERE target_user_id = ?').get(acct.id).c, 5);
  const items = raw.prepare('SELECT * FROM checklist_items WHERE case_id = 1').all();
  assert.ok(items.every((i) => i.status === 'DONE' && i.completed_by === 'DT-0004' && i.completed_at));
  const removed = raw.prepare("SELECT detail FROM checklist_links WHERE link_type = 'SOFTWARE_REMOVE'").all().map((l) => JSON.parse(l.detail).licenseName);
  assert.ok(removed.includes('오피스 제품군')); // 지워진 설치 기록이 연결 기록에 남아 있다

  // 완료 케이스는 더 실행 불가
  assert.equal((await exec(1, 'DISABLE_ACCOUNT')).body.error.code, 'CASE_CLOSED');
});

test('미처리 퇴사자 → 퇴사 케이스를 만들면 "처리 중"으로 표시', async () => {
  const r = await call('/api/lifecycle/cases', { method: 'POST', cookie: it, body: { caseType: 'OFFBOARDING', empNo: 'DT-0036', effectiveDate: addDays(TODAY, -3) } });
  assert.equal(r.status, 201);
  const list = await call('/api/lifecycle/cases', { cookie: it });
  assert.equal(list.body.warnings.find((w) => w.empNo === 'DT-0036').caseId, r.body.case.id);
  // 같은 사람에게 진행 중 퇴사 케이스 중복 불가
  const dup = await call('/api/lifecycle/cases', { method: 'POST', cookie: it, body: { caseType: 'OFFBOARDING', empNo: 'DT-0036', effectiveDate: TODAY } });
  assert.equal(dup.status, 409);
});

test('퇴사일 전에는 체크리스트에서 비활성화 불가 (TOO_EARLY)', async () => {
  const r = await call('/api/lifecycle/cases', { method: 'POST', cookie: it, body: { caseType: 'OFFBOARDING', empNo: 'DT-0030', effectiveDate: addDays(TODAY, 10) } });
  const res = await exec(r.body.case.id, 'DISABLE_ACCOUNT');
  assert.equal(res.body.error.code, 'TOO_EARLY');
});

test('입사: 계정 생성 → 업무 그룹 → 장비 지급 → SW 배정 → 안내, 라이선스 소모', async () => {
  const office0 = (await license('오피스 제품군')).installed;
  // 사용자 안내는 마지막
  assert.equal((await exec(2, 'USER_GUIDE', { note: 'x' })).body.error.code, 'BLOCKED');

  let r = await exec(2, 'CREATE_ACCOUNT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const acct = r.body.detail.account;
  assert.ok(acct);
  assert.equal(raw.prepare('SELECT employee_id FROM dir_users WHERE id = ?').get(acct.id).employee_id, 'DT-0041');
  assert.deepEqual(r.body.detail.items.find((i) => i.itemKey === 'CREATE_ACCOUNT').links[0].operation.eventIds, [4720, 4724, 4722, 4728]);

  r = await exec(2, 'ADD_ROLE_GROUPS');
  assert.ok(r.body.detail.account.groups.includes('GG-VPN-Users'));
  assert.ok(r.body.detail.account.groups.includes('GG-ERP-Users'));

  const stock = r.body.detail.stockDevices[0];
  assert.equal((await exec(2, 'ISSUE_DEVICE', {})).body.error.code, 'VALIDATION_FAILED');
  r = await exec(2, 'ISSUE_DEVICE', { assetId: stock.id });
  assert.equal(r.body.detail.devices[0].assetTag, stock.assetTag);

  r = await exec(2, 'ASSIGN_SOFTWARE');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await license('오피스 제품군')).installed, office0 + 1);

  r = await exec(2, 'USER_GUIDE', { note: '계정명 메일 전달, 초기 비밀번호는 팀장 통해 대면 전달, FAQ 안내' });
  assert.equal(r.body.detail.case.status, 'COMPLETED');
});

test('입사(연구개발팀): CAD 라이선스 초과 상태라 SW 배정 거부 (LICENSE_SHORTAGE)', async () => {
  const r = await call('/api/lifecycle/cases', {
    method: 'POST',
    cookie: it,
    body: { caseType: 'ONBOARDING', name: '설윤', deptCode: 'RND', jobTitle: '연구원', hireDate: addDays(TODAY, 3) },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.employee.empNo, 'DT-0042');
  assert.equal(r.body.employee.status, 'UPCOMING');
  const id = r.body.case.id;
  const stock = r.body.stockDevices[0];
  assert.equal((await exec(id, 'ISSUE_DEVICE', { assetId: stock.id })).status, 200);
  const sw = await exec(id, 'ASSIGN_SOFTWARE');
  assert.equal(sw.status, 409);
  assert.equal(sw.body.error.code, 'LICENSE_SHORTAGE');
  assert.match(sw.body.error.message, /CAD 설계/);
});
