// 3단계 완료 기준 검증: "라이선스 화면에서 초과·만료 임박·비인가 SW가 보인다"
// + 배정·반납·수리·폐기 흐름, 티켓-자산 연결. Worker fetch 를 직접 호출 (D1 대신 node:sqlite)

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
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const login = async (persona) =>
  (await call('/api/demo/login', { method: 'POST', body: { persona } })).headers.get('set-cookie').split(';')[0];
const idOf = (tag) => raw.prepare('SELECT id FROM assets WHERE asset_tag = ?').get(tag).id;

let it;
let employee;

test('준비: 초기화로 자산 60개·라이선스 8종', async () => {
  const r = await call('/api/admin/reset', { method: 'POST', body: {}, cookie: undefined });
  assert.equal(r.status, 401); // 토큰 없이는 불가
  const ok = await worker.fetch(
    new Request('http://localhost/api/admin/reset', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    env,
  );
  const body = await ok.json();
  assert.equal(body.assets, 60);
  assert.equal(body.licenses, 8);
  it = await login('it_admin');
  employee = await login('employee');
});

test('완료 기준: 라이선스 API 에 초과·만료 임박·비인가 SW 가 나온다', async () => {
  const r = await call('/api/licenses', { cookie: it });
  assert.equal(r.status, 200);
  assert.deepEqual(
    { over: r.body.summary.over, expiring: r.body.summary.expiring, sw: r.body.summary.unauthorizedSoftware, pcs: r.body.summary.unauthorizedAssets },
    { over: 1, expiring: 1, sw: 3, pcs: 4 },
  );
  const cad = r.body.licenses.find((l) => l.over);
  assert.equal(cad.installed, 4);
  assert.equal(cad.quantity, 3);
  assert.equal(r.body.licenses.find((l) => l.expiry.state === 'EXPIRING').expiry.daysLeft, 20);
  assert.ok(r.body.unauthorized.every((u) => u.assets.every((a) => a.assetTag)));
});

test('권한: 직원은 자산·라이선스 API 403', async () => {
  for (const p of ['/api/assets', '/api/licenses', '/api/assets/1', '/api/assets/meta']) {
    assert.equal((await call(p, { cookie: employee })).status, 403, p);
  }
});

test('자산 목록 필터: 종류·상태·검색', async () => {
  const printers = await call('/api/assets?type=PRINTER', { cookie: it });
  assert.equal(printers.body.count, 4);
  const stock = await call('/api/assets?status=IN_STOCK', { cookie: it });
  assert.equal(stock.body.count, 3);
  const active = await call('/api/assets?status=ACTIVE', { cookie: it });
  assert.equal(active.body.count, 58);
  const search = await call(`/api/assets?q=${encodeURIComponent('라벨')}`, { cookie: it });
  assert.equal(search.body.count, 1);
  assert.equal((await call('/api/assets?type=PHONE', { cookie: it })).status, 400);
});

test('배정 → 반납(고장) → 수리 → 재고 → 폐기, 폐기하면 라이선스 설치 수가 준다', async () => {
  // 재고 노트북 중 이전 사용 이력이 있는 것 (오피스 설치 없음) → 대신 수리 중 노트북으로 라이선스 감소 확인
  const stockId = raw.prepare("SELECT id FROM assets WHERE status = 'IN_STOCK' AND asset_type = 'LAPTOP' ORDER BY id LIMIT 1").get().id;
  const p = (x) => `/api/assets/${stockId}/${x}`;

  // 공용 장비는 배정 불가
  const printer = raw.prepare("SELECT id FROM assets WHERE asset_type = 'PRINTER' LIMIT 1").get().id;
  assert.equal((await call(`/api/assets/${printer}/assign`, { method: 'POST', cookie: it, body: { empNo: 'DT-0009' } })).body.error.code, 'NOT_ASSIGNABLE');
  // 없는 직원
  assert.equal((await call(p('assign'), { method: 'POST', cookie: it, body: { empNo: 'DT-9999' } })).status, 400);

  let r = await call(p('assign'), { method: 'POST', cookie: it, body: { empNo: 'DT-0009', note: '외근용 추가 지급' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.asset.status, 'IN_USE');
  assert.equal(r.body.asset.holder.empNo, 'DT-0009');

  // 사용 중에는 바로 폐기 불가, 이중 배정 불가
  assert.equal((await call(p('status'), { method: 'POST', cookie: it, body: { to: 'DISPOSED', note: 'x' } })).body.error.code, 'IN_USE');
  assert.equal((await call(p('assign'), { method: 'POST', cookie: it, body: { empNo: 'DT-0010' } })).status, 409);

  // 고장 반납은 사유 필수
  assert.equal((await call(p('return'), { method: 'POST', cookie: it, body: { condition: 'REPAIR' } })).status, 400);
  r = await call(p('return'), { method: 'POST', cookie: it, body: { condition: 'REPAIR', note: '화면 줄 생김' } });
  assert.equal(r.body.asset.status, 'REPAIR');
  assert.equal(r.body.asset.holder, null);
  assert.equal(r.body.assignments[0].returnCondition, 'REPAIR');
  assert.equal(r.body.assignments[0].employee.empNo, 'DT-0009');

  r = await call(p('status'), { method: 'POST', cookie: it, body: { to: 'IN_STOCK' } });
  assert.equal(r.body.asset.status, 'IN_STOCK');

  // 수리 중 노트북(오피스 설치됨)을 폐기 → 오피스 설치 수 33 → 32
  const before = (await call('/api/licenses', { cookie: it })).body.licenses.find((l) => l.id === 1).installed;
  const repairId = raw.prepare("SELECT id FROM assets WHERE status = 'REPAIR'").get().id;
  r = await call(`/api/assets/${repairId}/status`, { method: 'POST', cookie: it, body: { to: 'DISPOSED', note: '수리비 과다로 폐기' } });
  assert.equal(r.body.asset.status, 'DISPOSED');
  const after = (await call('/api/licenses', { cookie: it })).body.licenses.find((l) => l.id === 1).installed;
  assert.equal(after, before - 1);

  // 폐기는 마지막 상태
  assert.equal((await call(`/api/assets/${repairId}/status`, { method: 'POST', cookie: it, body: { to: 'IN_STOCK' } })).status, 409);
});

test('자산 상세: 배정 이력·설치 SW 분류·관련 티켓', async () => {
  const label = idOf(raw.prepare("SELECT asset_tag FROM assets WHERE model LIKE '%라벨%'").get().asset_tag);
  const r = await call(`/api/assets/${label}`, { cookie: it });
  assert.equal(r.status, 200);
  assert.ok(r.body.tickets.some((t) => t.title.includes('라벨 프린터')));

  const line2 = raw.prepare("SELECT id FROM assets WHERE location = '제1공장 생산라인 2'").get().id;
  const sw = (await call(`/api/assets/${line2}`, { cookie: it })).body.software;
  assert.equal(sw.find((s) => s.name === '게임 런처').classification, 'UNAUTHORIZED');
  assert.equal(sw.find((s) => s.name.startsWith('엔드포인트 백신')).classification, 'LICENSED');
  assert.equal(sw.find((s) => s.name === '웹 브라우저').classification, 'ALLOWED');
});

test('티켓 상세: 요청자 배정 자산 표시(직원 본인도), 연결·해제 이력', async () => {
  const mine = raw.prepare("SELECT id FROM tickets WHERE requester_emp_no = 'DT-0009' ORDER BY id LIMIT 1").get().id;
  const asEmployee = await call(`/api/tickets/${mine}`, { cookie: employee });
  assert.ok(asEmployee.body.requesterAssets.length >= 1);
  assert.deepEqual(asEmployee.body.linkableAssets, []);

  const asIt = await call(`/api/tickets/${mine}`, { cookie: it });
  const personal = asIt.body.requesterAssets[0];
  assert.ok(asIt.body.linkableAssets.length > asIt.body.requesterAssets.length, '공용 장비도 후보');

  let r = await call(`/api/tickets/${mine}/asset`, { method: 'PUT', cookie: it, body: { assetId: personal.id } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.asset.assetTag, personal.assetTag);
  const ev = r.body.events.at(-1);
  assert.equal(ev.type, 'LINK_CHANGED');
  assert.equal(ev.data.kind, 'asset');
  assert.equal(ev.data.to.assetTag, personal.assetTag);

  // 폐기 자산은 연결 불가, 직원은 연결 불가
  const disposed = raw.prepare("SELECT id FROM assets WHERE status = 'DISPOSED' LIMIT 1").get().id;
  assert.equal((await call(`/api/tickets/${mine}/asset`, { method: 'PUT', cookie: it, body: { assetId: disposed } })).body.error.code, 'ASSET_DISPOSED');
  assert.equal((await call(`/api/tickets/${mine}/asset`, { method: 'PUT', cookie: employee, body: { assetId: personal.id } })).status, 403);

  r = await call(`/api/tickets/${mine}/asset`, { method: 'PUT', cookie: it, body: { assetId: null } });
  assert.equal(r.body.ticket.asset, null);
});

test('DB 이중 안전장치: 한 자산에 열린 배정 2건은 DB가 거부', () => {
  const holderAsset = raw.prepare('SELECT asset_id FROM asset_assignments WHERE returned_at IS NULL LIMIT 1').get().asset_id;
  assert.throws(() =>
    raw
      .prepare("INSERT INTO asset_assignments (asset_id, emp_no, assigned_at, assigned_by) VALUES (?, 'DT-0010', 'x', 'DT-0004')")
      .run(holderAsset),
  );
});
