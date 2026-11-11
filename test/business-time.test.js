import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessMinutes,
  subtractBusinessMinutes,
  businessMinutesBetween,
  isBusinessTime,
  workdayMinutes,
} from '../src/lib/business-time.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';

// KST 벽시계 문자열 → Date
const kst = (s) => new Date(`${s}:00+09:00`);
// Date → KST 'YYYY-MM-DDTHH:mm'
const fmt = (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 16);

// 달력 기준 확인: 2026-11-13 금요일, 11-16 월요일
test('기준 날짜의 요일 확인', () => {
  assert.equal(new Date('2026-11-13T12:00:00Z').getUTCDay(), 5);
  assert.equal(new Date('2026-11-16T12:00:00Z').getUTCDay(), 1);
});

test('하루 업무 시간은 9시간(540분)', () => {
  assert.equal(workdayMinutes(SLA_CONFIG), 540);
});

test('금요일 17:00 + 4시간 → 월요일 12:00 (금 1시간 + 월 3시간)', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-13T17:00'), 240, SLA_CONFIG)), '2026-11-16T12:00');
});

test('금요일 18:00 정각 + 1영업일(540분) → 월요일 18:00 (월요일 하루를 다 씀)', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-13T18:00'), 540, SLA_CONFIG)), '2026-11-16T18:00');
});

test('토요일 접수는 월요일 09:00부터 센다', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-14T10:00'), 240, SLA_CONFIG)), '2026-11-16T13:00');
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-14T10:00'), 0, SLA_CONFIG)), '2026-11-16T09:00');
});

test('08:59 접수는 09:00부터 센다', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-16T08:59'), 60, SLA_CONFIG)), '2026-11-16T10:00');
});

test('월요일 10:00 + 3영업일(1620분) → 목요일 10:00', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-16T10:00'), 1620, SLA_CONFIG)), '2026-11-19T10:00');
});

test('평일 17:30 + 1시간 → 다음 날 09:30', () => {
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-11T17:30'), 60, SLA_CONFIG)), '2026-11-12T09:30');
});

test('두 시각 사이 업무 시간: 주말을 건너뛴다', () => {
  assert.equal(businessMinutesBetween(kst('2026-11-13T17:00'), kst('2026-11-16T12:00'), SLA_CONFIG), 240);
  assert.equal(businessMinutesBetween(kst('2026-11-14T09:00'), kst('2026-11-15T23:00'), SLA_CONFIG), 0);
  assert.equal(businessMinutesBetween(kst('2026-11-16T12:00'), kst('2026-11-13T17:00'), SLA_CONFIG), 0);
  assert.equal(businessMinutesBetween(kst('2026-11-16T07:00'), kst('2026-11-16T20:00'), SLA_CONFIG), 540);
});

test('거꾸로 계산: 월요일 10:00 - 2시간 → 금요일 17:00', () => {
  assert.equal(fmt(subtractBusinessMinutes(kst('2026-11-16T10:00'), 120, SLA_CONFIG)), '2026-11-13T17:00');
  // 업무 시간 밖(새벽)에서 0분 → 직전 업무일 18:00
  assert.equal(fmt(subtractBusinessMinutes(kst('2026-11-16T04:30'), 0, SLA_CONFIG)), '2026-11-13T18:00');
});

test('더하기와 빼기는 서로 되돌린다', () => {
  const start = kst('2026-11-12T15:20');
  for (const m of [1, 100, 539, 540, 541, 2000]) {
    const end = addBusinessMinutes(start, m, SLA_CONFIG);
    assert.equal(businessMinutesBetween(start, end, SLA_CONFIG), m, `분=${m}`);
  }
});

test('업무 시간 판정: 시작 포함, 끝 미포함, 주말 제외', () => {
  assert.equal(isBusinessTime(kst('2026-11-16T09:00'), SLA_CONFIG), true);
  assert.equal(isBusinessTime(kst('2026-11-16T17:59'), SLA_CONFIG), true);
  assert.equal(isBusinessTime(kst('2026-11-16T18:00'), SLA_CONFIG), false);
  assert.equal(isBusinessTime(kst('2026-11-14T10:00'), SLA_CONFIG), false);
});

test('공휴일 설정이 있으면 그날을 건너뛴다', () => {
  const cfg = { ...SLA_CONFIG, holidays: ['2026-11-16'] };
  assert.equal(fmt(addBusinessMinutes(kst('2026-11-13T17:00'), 240, cfg)), '2026-11-17T12:00');
});
