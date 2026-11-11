import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetMinutes, computeDueAt, resumeSla, slaState } from '../src/lib/sla.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';

const kst = (s) => new Date(`${s}:00+09:00`);
const fmt = (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 16);

test('긴급도별 목표: 긴급 4h / 높음 8h / 보통 1영업일 / 낮음 3영업일', () => {
  assert.equal(targetMinutes('URGENT', SLA_CONFIG), 240);
  assert.equal(targetMinutes('HIGH', SLA_CONFIG), 480);
  assert.equal(targetMinutes('NORMAL', SLA_CONFIG), 540);
  assert.equal(targetMinutes('LOW', SLA_CONFIG), 1620);
  assert.throws(() => targetMinutes('CRITICAL', SLA_CONFIG));
});

test('설정값을 바꾸면 결과가 바뀐다 (영업일 = 업무 시간 길이)', () => {
  const cfg = { ...SLA_CONFIG, workdayEndHour: 17 };
  assert.equal(targetMinutes('NORMAL', cfg), 480);
});

test('금요일 17:00 긴급 접수 → 기한 월요일 12:00, 보류 60분이면 13:00', () => {
  assert.equal(fmt(computeDueAt(kst('2026-11-13T17:00'), 'URGENT', 0, SLA_CONFIG)), '2026-11-16T12:00');
  assert.equal(fmt(computeDueAt(kst('2026-11-13T17:00'), 'URGENT', 60, SLA_CONFIG)), '2026-11-16T13:00');
});

test('보류 → 재개: 멈춘 업무 시간만큼 기한이 밀린다 (주말은 멈춘 시간에도 안 셈)', () => {
  const t = {
    createdAt: kst('2026-11-13T10:00'),
    priority: 'HIGH',
    pausedMinutes: 0,
    holdStartedAt: kst('2026-11-13T16:00'),
  };
  const r = resumeSla(t, kst('2026-11-16T10:00'), SLA_CONFIG); // 금 2h + 월 1h = 180분
  assert.equal(r.addedMinutes, 180);
  assert.equal(r.pausedMinutes, 180);
  // 접수 금 10:00 + (480 + 180)분 → 금 8h(480) + 월 180분 → 월 12:00
  assert.equal(fmt(r.dueAt), '2026-11-16T12:00');
});

const open = (status, priority, due) => ({ status, priority, dueAt: kst(due) });

test('정상 / 임박(남은 시간 ≤ 목표의 25%) / 초과', () => {
  const t = open('IN_PROGRESS', 'URGENT', '2026-11-16T12:00');
  assert.equal(slaState(t, kst('2026-11-16T09:00'), SLA_CONFIG).state, 'ON_TRACK');
  // 남은 60분 = 240의 25% → 임박 (경계 포함)
  const imminent = slaState(t, kst('2026-11-16T11:00'), SLA_CONFIG);
  assert.equal(imminent.state, 'IMMINENT');
  assert.equal(imminent.remainingMinutes, 60);
  assert.equal(slaState(t, kst('2026-11-16T10:59'), SLA_CONFIG).state, 'ON_TRACK');
  // 기한 정각 = 초과
  assert.equal(slaState(t, kst('2026-11-16T12:00'), SLA_CONFIG).state, 'OVERDUE');
});

test('업무 시간 밖에서 본 남은 시간: 금요일 밤 → 월요일 10:00 기한은 60분 남음', () => {
  const t = open('ASSIGNED', 'URGENT', '2026-11-16T10:00');
  const s = slaState(t, kst('2026-11-13T20:00'), SLA_CONFIG);
  assert.equal(s.remainingMinutes, 60);
  assert.equal(s.state, 'IMMINENT');
});

test('보류 중이면 시계 정지, 완료는 기한 내/초과로 판정', () => {
  assert.equal(slaState(open('ON_HOLD', 'LOW', '2026-11-10T10:00'), kst('2026-11-16T10:00'), SLA_CONFIG).state, 'PAUSED');
  const due = kst('2026-11-16T12:00');
  assert.equal(slaState({ status: 'RESOLVED', priority: 'URGENT', dueAt: due, resolvedAt: kst('2026-11-16T12:00') }, new Date(), SLA_CONFIG).state, 'MET');
  assert.equal(slaState({ status: 'RESOLVED', priority: 'URGENT', dueAt: due, resolvedAt: kst('2026-11-16T12:01') }, new Date(), SLA_CONFIG).state, 'BREACHED');
});
