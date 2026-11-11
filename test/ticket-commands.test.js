import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planCreate,
  planAssign,
  planStatusChange,
  planNote,
  planLinkChange,
  planFaq,
  planAssetLink,
  buildFaqDraft,
} from '../src/lib/ticket-commands.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';

const kst = (s) => new Date(`${s}:00+09:00`);
const cfg = SLA_CONFIG;
const ASSIGNEES = ['DT-0004', 'DT-0003'];
const BASE = 'https://status-monitor.example.workers.dev';

function ticket(overrides = {}) {
  return {
    id: 5,
    requesterEmpNo: 'DT-0009',
    category: 'PRINTER',
    priority: 'URGENT',
    title: '라벨 프린터 출력 안 됨',
    symptom: '출하 라벨이 안 나옵니다',
    status: 'IN_PROGRESS',
    assigneeEmpNo: 'DT-0004',
    createdAt: kst('2026-11-13T17:00'),
    slaDueAt: kst('2026-11-16T12:00'),
    slaPausedMinutes: 0,
    holdStartedAt: null,
    resolvedAt: null,
    cause: null,
    actionTaken: null,
    verification: null,
    incidentUrl: null,
    version: 3,
    ...overrides,
  };
}

test('접수: 상태는 접수, 기한은 업무 시간 기준 (금 17:00 긴급 → 월 12:00)', () => {
  const p = planCreate(
    { category: 'PRINTER', priority: 'URGENT', title: '출력 안 됨', symptom: '오프라인' },
    { now: kst('2026-11-13T17:00'), requesterEmpNo: 'DT-0009', cfg },
  );
  assert.equal(p.ok, true);
  assert.equal(p.row.status, 'RECEIVED');
  assert.equal(p.row.sla_due_at, kst('2026-11-16T12:00').toISOString());
  assert.equal(p.events[0].eventType, 'CREATED');
});

test('배정: 접수 상태면 상태도 배정으로, 이력 2건', () => {
  const p = planAssign(ticket({ status: 'RECEIVED', assigneeEmpNo: null }), { assigneeEmpNo: 'DT-0004' }, { assigneeEmpNos: ASSIGNEES });
  assert.equal(p.ok, true);
  assert.deepEqual(p.changes, { assignee_emp_no: 'DT-0004', status: 'ASSIGNED' });
  assert.deepEqual(p.events.map((e) => e.eventType), ['ASSIGNED', 'STATUS_CHANGED']);
});

test('재배정: 상태는 그대로, 이력 1건 (이전·새 담당자 기록)', () => {
  const p = planAssign(ticket(), { assigneeEmpNo: 'DT-0003' }, { assigneeEmpNos: ASSIGNEES });
  assert.deepEqual(p.changes, { assignee_emp_no: 'DT-0003' });
  assert.deepEqual(p.events[0].data, { from: 'DT-0004', to: 'DT-0003' });
});

test('배정 거부: IT 담당자가 아닌 사람, 같은 담당자, 완료 티켓', () => {
  assert.equal(planAssign(ticket(), { assigneeEmpNo: 'DT-0009' }, { assigneeEmpNos: ASSIGNEES }).code, 'INVALID_ASSIGNEE');
  assert.equal(planAssign(ticket(), { assigneeEmpNo: 'DT-0004' }, { assigneeEmpNos: ASSIGNEES }).code, 'ALREADY_ASSIGNED');
  assert.equal(planAssign(ticket({ status: 'RESOLVED' }), { assigneeEmpNo: 'DT-0003' }, { assigneeEmpNos: ASSIGNEES }).code, 'TICKET_CLOSED');
});

test('상태 변경 거부: 규칙에 없는 전이, 배정은 별도 API', () => {
  const now = kst('2026-11-16T10:00');
  assert.equal(planStatusChange(ticket({ status: 'RECEIVED' }), { to: 'RESOLVED' }, { now, cfg }).code, 'INVALID_TRANSITION');
  assert.equal(planStatusChange(ticket({ status: 'RESOLVED' }), { to: 'IN_PROGRESS' }, { now, cfg }).httpStatus, 409);
  assert.equal(planStatusChange(ticket({ status: 'RECEIVED' }), { to: 'ASSIGNED' }, { now, cfg }).code, 'USE_ASSIGN');
  assert.equal(planStatusChange(ticket(), { to: 'NOPE' }, { now, cfg }).code, 'INVALID_TRANSITION');
});

test('보류: 사유 필수, 시계 정지 시작 시각 기록', () => {
  const now = kst('2026-11-16T10:00');
  assert.equal(planStatusChange(ticket(), { to: 'ON_HOLD', note: '  ' }, { now, cfg }).code, 'VALIDATION_FAILED');
  const p = planStatusChange(ticket(), { to: 'ON_HOLD', note: '부품 대기' }, { now, cfg });
  assert.equal(p.ok, true);
  assert.equal(p.changes.hold_started_at, now.toISOString());
  assert.equal(p.events[0].note, '부품 대기');
});

test('재개: 보류로 멈춘 업무 시간만큼 기한이 밀린다', () => {
  const t = ticket({ status: 'ON_HOLD', holdStartedAt: kst('2026-11-16T10:00') });
  const p = planStatusChange(t, { to: 'IN_PROGRESS' }, { now: kst('2026-11-16T11:30'), cfg });
  assert.equal(p.ok, true);
  assert.equal(p.changes.sla_paused_minutes, 90);
  assert.equal(p.changes.hold_started_at, null);
  // 원래 기한 월 12:00 + 90분 → 월 13:30
  assert.equal(p.changes.sla_due_at, kst('2026-11-16T13:30').toISOString());
});

test('완료: 원인·조치·검증 결과가 비면 서버에서 거부', () => {
  const now = kst('2026-11-16T11:00');
  const r = planStatusChange(ticket(), { to: 'RESOLVED', cause: '드라이버 오류', action: '재설치', verification: ' ' }, { now, cfg });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RESOLUTION_REQUIRED');
  assert.deepEqual(r.errors.map((e) => e.field), ['verification']);

  const ok = planStatusChange(
    ticket(),
    { to: 'RESOLVED', cause: '드라이버 오류', action: '재설치', verification: '테스트 출력 정상' },
    { now, cfg },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.changes.resolved_at, now.toISOString());
  assert.equal(ok.changes.action_taken, '재설치');
});

test('메모: 빈 메모·완료 티켓은 거부', () => {
  assert.equal(planNote(ticket(), { note: '사용자와 통화함' }).ok, true);
  assert.equal(planNote(ticket(), { note: '' }).ok, false);
  assert.equal(planNote(ticket({ status: 'RESOLVED' }), { note: 'x' }).code, 'TICKET_CLOSED');
});

test('B 장애 링크: 저장·삭제·변경 없음', () => {
  const set = planLinkChange(ticket(), { url: `${BASE}/incidents/12` }, { baseUrl: BASE });
  assert.equal(set.ok, true);
  assert.equal(set.changes.incident_url, `${BASE}/incidents/12`);
  const cleared = planLinkChange(ticket({ incidentUrl: `${BASE}/incidents/12` }), { url: '' }, { baseUrl: BASE });
  assert.equal(cleared.changes.incident_url, null);
  assert.equal(planLinkChange(ticket(), { url: '' }, { baseUrl: BASE }).code, 'NO_CHANGE');
  assert.equal(planLinkChange(ticket(), { url: 'https://evil.example/x' }, { baseUrl: BASE }).code, 'INVALID_LINK');
});

test('자산 연결: 연결·해제·변경 없음·폐기 자산·잘못된 값', () => {
  const asset = { id: 12, assetTag: 'NB-0012', status: 'IN_USE' };
  const set = planAssetLink(ticket(), { assetId: 12 }, { asset });
  assert.equal(set.ok, true);
  assert.deepEqual(set.changes, { asset_id: 12 });
  assert.deepEqual(set.events[0].data, { kind: 'asset', from: null, to: { id: 12, assetTag: 'NB-0012' } });

  const cleared = planAssetLink(ticket({ assetId: 12 }), { assetId: null }, { asset: null, currentAssetTag: 'NB-0012' });
  assert.deepEqual(cleared.changes, { asset_id: null });
  assert.deepEqual(cleared.events[0].data.from, { id: 12, assetTag: 'NB-0012' });

  assert.equal(planAssetLink(ticket({ assetId: 12 }), { assetId: 12 }, { asset }).code, 'NO_CHANGE');
  assert.equal(planAssetLink(ticket(), { assetId: 3 }, { asset: { ...asset, status: 'DISPOSED' } }).code, 'ASSET_DISPOSED');
  assert.equal(planAssetLink(ticket(), { assetId: 99 }, { asset: null }).code, 'INVALID_ASSET');
  assert.equal(planAssetLink(ticket(), { assetId: 'abc' }, { asset: null }).code, 'INVALID_ASSET');
});

test('FAQ: 완료 티켓만, 한 번만, 초안에 요청자 정보 없음', () => {
  const done = ticket({ status: 'RESOLVED', cause: '원인', actionTaken: '조치', verification: '확인' });
  const input = { title: '라벨 프린터가 안 될 때', question: '라벨이 안 나와요', answer: '드라이버 재설치' };
  assert.equal(planFaq(ticket(), input, { hasFaq: false }).code, 'NOT_RESOLVED');
  assert.equal(planFaq(done, input, { hasFaq: true }).code, 'FAQ_EXISTS');
  assert.equal(planFaq(done, { ...input, answer: ' ' }, { hasFaq: false }).ok, false);
  const p = planFaq(done, input, { hasFaq: false });
  assert.equal(p.ok, true);
  assert.equal(p.faq.category, 'PRINTER');

  const draft = buildFaqDraft(done);
  const text = JSON.stringify(draft);
  assert.ok(!text.includes('DT-0009'));
  assert.ok(draft.answer.includes('원인: 원인'));
});
