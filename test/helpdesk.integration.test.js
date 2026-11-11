// 2단계 완료 기준 검증:
// "직원으로 접수 → IT 담당자로 완료까지 가능하고 모든 변경이 이력에 남는다"
// Worker 의 fetch 를 직접 호출한다 (D1 대신 node:sqlite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { createFakeD1 } from './helpers/fake-d1.js';

const ADMIN_TOKEN = 'integration-test-admin-token-0123456789';
const B = 'https://status-monitor.nalzzoaleph26.workers.dev';
const { D1, raw } = createFakeD1(fileURLToPath(new URL('../migrations', import.meta.url)));
const env = { DB: D1, ADMIN_TOKEN, UPTIME_MONITOR_BASE_URL: B };

async function call(path, { method = 'GET', body, cookie, headers = {}, envOverride } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`http://localhost${path}`, init), envOverride ?? env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function login(persona) {
  const r = await call('/api/demo/login', { method: 'POST', body: { persona } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

let employee;
let it;
let ticketId;

test('준비: 관리자 초기화로 직원(재직 40 + 입사 예정 1)·티켓 30건이 들어간다', async () => {
  const r = await call('/api/admin/reset', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal(r.body.employees, 41);
  assert.equal(r.body.tickets, 30);
  employee = await login('employee');
  it = await login('it_admin');
});

test('직원: 빈 증상은 거부, 정상 접수는 201', async () => {
  const bad = await call('/api/tickets', {
    method: 'POST',
    cookie: employee,
    body: { category: 'PRINTER', priority: 'URGENT', title: '프린터 안 됨', symptom: '   ' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.errors[0].field, 'symptom');

  const ok = await call('/api/tickets', {
    method: 'POST',
    cookie: employee,
    body: { category: 'PRINTER', priority: 'URGENT', title: '영업팀 프린터 용지 걸림', symptom: '용지가 없는데 걸림 오류가 납니다' },
  });
  assert.equal(ok.status, 201);
  ticketId = ok.body.id;
  assert.equal(ticketId, 31);
  assert.equal(ok.body.ticketNo, 'HD-0031');
});

test('직원: 내 요청만 보이고, 남의 티켓은 404, IT 작업은 403', async () => {
  const mine = await call('/api/tickets?assignee=DT-0004', { cookie: employee });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.count, 4); // 데모 3건 + 방금 접수 1건
  assert.ok(mine.body.tickets.every((t) => t.requester.empNo === 'DT-0009'));

  const other = raw.prepare("SELECT id FROM tickets WHERE requester_emp_no <> 'DT-0009' LIMIT 1").get().id;
  assert.equal((await call(`/api/tickets/${other}`, { cookie: employee })).status, 404);
  const forbidden = await call(`/api/tickets/${ticketId}/assign`, { method: 'POST', cookie: employee, body: { assigneeEmpNo: 'DT-0004' } });
  assert.equal(forbidden.status, 403);
});

test('IT 담당자: 필터·검색', async () => {
  const open = await call('/api/tickets?status=OPEN', { cookie: it });
  assert.equal(open.body.count, 19); // 미완료 18 + 새 접수 1
  const search = await call(`/api/tickets?q=${encodeURIComponent('라벨 프린터')}`, { cookie: it });
  assert.ok(search.body.count >= 1);
  assert.ok(search.body.tickets.every((t) => t.title.includes('라벨 프린터') || t.symptom.includes('라벨 프린터')));
  const overdue = await call('/api/tickets?sla=OVERDUE', { cookie: it });
  assert.ok(overdue.body.tickets.every((t) => t.sla.state === 'OVERDUE'));
  assert.equal((await call('/api/tickets?status=DELETED', { cookie: it })).status, 400);
});

test('IT 담당자: 배정 → 처리 중 → 메모 → 보류 → 재개 → 완료 (규칙 위반은 거부)', async () => {
  const path = (p) => `/api/tickets/${ticketId}/${p}`;

  // 접수 상태에서 바로 완료는 불가
  let r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'RESOLVED', cause: 'a', action: 'b', verification: 'c' } });
  assert.equal(r.status, 409);

  // IT 담당자 목록 밖의 사람에게는 배정 불가
  r = await call(path('assign'), { method: 'POST', cookie: it, body: { assigneeEmpNo: 'DT-0009' } });
  assert.equal(r.status, 400);

  r = await call(path('assign'), { method: 'POST', cookie: it, body: { assigneeEmpNo: 'DT-0004' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.status, 'ASSIGNED');

  r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'IN_PROGRESS' } });
  assert.equal(r.body.ticket.status, 'IN_PROGRESS');

  r = await call(path('notes'), { method: 'POST', cookie: it, body: { note: '현장 확인: 급지 롤러 마모 의심' } });
  assert.equal(r.status, 200);

  r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'ON_HOLD', note: ' ' } });
  assert.equal(r.status, 400);
  r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'ON_HOLD', note: '롤러 입고 대기' } });
  assert.equal(r.body.ticket.sla.state, 'PAUSED');

  r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'IN_PROGRESS' } });
  assert.equal(r.body.ticket.status, 'IN_PROGRESS');

  // 완료: 검증 결과가 비면 서버에서 거부
  r = await call(path('status'), { method: 'POST', cookie: it, body: { to: 'RESOLVED', cause: '롤러 마모', action: '롤러 교체', verification: '' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'RESOLUTION_REQUIRED');

  r = await call(path('status'), {
    method: 'POST',
    cookie: it,
    body: { to: 'RESOLVED', cause: '롤러 마모', action: '롤러 교체', verification: '테스트 20매 출력 정상' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.status, 'RESOLVED');
  assert.equal(r.body.ticket.resolution.verification, '테스트 20매 출력 정상');
  assert.ok(['MET', 'BREACHED'].includes(r.body.ticket.sla.state));

  // 완료 후에는 상태 변경·메모 불가
  assert.equal((await call(path('status'), { method: 'POST', cookie: it, body: { to: 'IN_PROGRESS' } })).status, 409);
  assert.equal((await call(path('notes'), { method: 'POST', cookie: it, body: { note: 'x' } })).status, 409);
});

test('B 장애 링크: B 주소만 저장', async () => {
  const path = `/api/tickets/${ticketId}/incident-link`;
  assert.equal((await call(path, { method: 'PUT', cookie: it, body: { url: 'https://evil.example/1' } })).status, 400);
  const r = await call(path, { method: 'PUT', cookie: it, body: { url: `${B}/incidents/7` } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ticket.incidentUrl, `${B}/incidents/7`);
});

test('FAQ: 완료 티켓 등록은 한 번만, 직원 FAQ 목록에는 원본 티켓 정보 없음', async () => {
  const detail = await call(`/api/tickets/${ticketId}`, { cookie: it });
  assert.ok(detail.body.faqDraft);
  const body = { title: '프린터 용지 걸림이 반복될 때', question: '용지가 없는데 걸림 오류가 납니다', answer: '급지 롤러 마모일 수 있습니다. IT 담당자에게 요청하세요.' };
  assert.equal((await call(`/api/tickets/${ticketId}/faq`, { method: 'POST', cookie: it, body })).status, 200);
  assert.equal((await call(`/api/tickets/${ticketId}/faq`, { method: 'POST', cookie: it, body })).status, 409);

  const list = await call('/api/faq', { cookie: employee });
  assert.equal(list.body.faqs.length, 4);
  assert.ok(list.body.faqs.every((f) => f.sourceTicket === null));
});

test('완료 기준: 모든 변경이 이력에 순서대로 남는다 (직원도 자기 티켓 이력을 본다)', async () => {
  const r = await call(`/api/tickets/${ticketId}`, { cookie: employee });
  assert.equal(r.status, 200);
  const trail = r.body.events.map((e) => (e.type === 'STATUS_CHANGED' ? `${e.fromStatus}>${e.toStatus}` : e.type));
  assert.deepEqual(trail, [
    'CREATED',
    'ASSIGNED',
    'RECEIVED>ASSIGNED',
    'ASSIGNED>IN_PROGRESS',
    'NOTE',
    'IN_PROGRESS>ON_HOLD',
    'ON_HOLD>IN_PROGRESS',
    'IN_PROGRESS>RESOLVED',
    'LINK_CHANGED',
    'FAQ_PUBLISHED',
  ]);
  assert.equal(r.body.events[0].actor.empNo, 'DT-0009');
  assert.ok(r.body.events.slice(1).every((e) => e.actor.empNo === 'DT-0004'));
  // 거부된 요청은 이력에 남지 않는다
  const count = raw.prepare('SELECT COUNT(*) AS c FROM ticket_events WHERE ticket_id = ?').get(ticketId).c;
  assert.equal(count, 10);
});

test('동시 수정: 읽은 뒤 다른 사람이 먼저 바꾸면 409, 이력도 남지 않는다', async () => {
  const target = raw.prepare("SELECT id FROM tickets WHERE status = 'ASSIGNED' LIMIT 1").get().id;
  const before = raw.prepare('SELECT COUNT(*) AS c FROM ticket_events WHERE ticket_id = ?').get(target).c;
  // batch 직전에 다른 요청이 끼어든 상황을 흉내: 버전을 올려 둔다
  const racingDb = {
    ...D1,
    batch: async (stmts) => {
      raw.prepare('UPDATE tickets SET version = version + 1 WHERE id = ?').run(target);
      return D1.batch(stmts);
    },
  };
  const r = await call(`/api/tickets/${target}/status`, {
    method: 'POST',
    cookie: it,
    body: { to: 'IN_PROGRESS' },
    envOverride: { ...env, DB: racingDb },
  });
  assert.equal(r.status, 409);
  assert.equal(raw.prepare('SELECT status FROM tickets WHERE id = ?').get(target).status, 'ASSIGNED');
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM ticket_events WHERE ticket_id = ?').get(target).c, before);
});

test('DB 이중 안전장치: 원인 없이 완료로 바꾸는 SQL 은 DB 가 거부한다', () => {
  assert.throws(() =>
    raw.prepare("UPDATE tickets SET status = 'RESOLVED', resolved_at = 'x' WHERE status = 'IN_PROGRESS'").run(),
  );
});
