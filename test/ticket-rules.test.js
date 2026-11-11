import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  TRANSITIONS,
  canTransition,
  validateNewTicket,
  validateResolution,
  ticketNo,
} from '../src/lib/ticket-rules.js';

const ALL = Object.keys(STATUSES);
const ALLOWED = new Set([
  'RECEIVED>ASSIGNED',
  'ASSIGNED>IN_PROGRESS',
  'IN_PROGRESS>ON_HOLD',
  'IN_PROGRESS>RESOLVED',
  'ON_HOLD>IN_PROGRESS',
]);

test('상태 전이: 허용 5가지 외에는 전부 거부 (5×5 전수 검사)', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      assert.equal(canTransition(from, to), ALLOWED.has(`${from}>${to}`), `${from} → ${to}`);
    }
  }
});

test('단계 건너뛰기·완료 후 되돌리기·알 수 없는 상태는 거부', () => {
  assert.equal(canTransition('RECEIVED', 'RESOLVED'), false);
  assert.equal(canTransition('ASSIGNED', 'RESOLVED'), false);
  assert.equal(canTransition('ON_HOLD', 'RESOLVED'), false);
  assert.equal(canTransition('RESOLVED', 'IN_PROGRESS'), false);
  assert.equal(canTransition('IN_PROGRESS', 'CLOSED'), false);
  assert.equal(canTransition('__proto__', 'ASSIGNED'), false);
  assert.deepEqual(TRANSITIONS.RESOLVED, []);
});

test('접수 검증: 분류·긴급도는 목록 안, 제목·증상은 공백만으로는 안 됨', () => {
  const ok = validateNewTicket({ category: 'PRINTER', priority: 'HIGH', title: '  출력 안 됨 ', symptom: '오프라인' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.title, '출력 안 됨');

  const bad = validateNewTicket({ category: 'COFFEE', priority: 'ASAP', title: '   ', symptom: '\n\t' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['category', 'priority', 'symptom', 'title']);

  assert.equal(validateNewTicket(null).ok, false);
  assert.equal(validateNewTicket({ category: 'PC', priority: 'LOW', title: 'x'.repeat(101), symptom: 'a' }).ok, false);
});

test('완료 검증: 원인·조치·검증 결과 중 하나라도 비면 거부', () => {
  const full = { cause: '롤러 마모', action: '롤러 교체', verification: '50매 출력 정상' };
  assert.equal(validateResolution(full).ok, true);
  for (const field of ['cause', 'action', 'verification']) {
    for (const empty of [undefined, '', '   ', '\n']) {
      const r = validateResolution({ ...full, [field]: empty });
      assert.equal(r.ok, false, `${field}=${JSON.stringify(empty)}`);
      assert.deepEqual(r.errors.map((e) => e.field), [field]);
    }
  }
  assert.equal(validateResolution({ ...full, cause: 123 }).ok, false);
});

test('티켓 번호 표시', () => {
  assert.equal(ticketNo(7), 'HD-0007');
  assert.equal(ticketNo(1234), 'HD-1234');
});
