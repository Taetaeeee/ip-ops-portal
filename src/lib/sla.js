// SLA 계산 (순수 함수).
//
// 용어:
// - 목표(target): 긴급도별 처리 목표 시간 (업무 시간 기준)
// - 기한(dueAt): 접수 시각 + 목표 + 보류로 멈춘 시간
// - 보류 중에는 시계가 멈춘다. 사용자 응답·부품을 기다리는 시간은 IT 담당자가 줄일 수 없기 때문.
//   보류를 풀 때(재개) 멈춘 시간만큼 기한을 뒤로 민다.

import { addBusinessMinutes, businessMinutesBetween, workdayMinutes } from './business-time.js';

export const SLA_STATES = Object.freeze({
  ON_TRACK: '정상',
  IMMINENT: '임박',
  OVERDUE: '초과',
  PAUSED: '보류(시계 정지)',
  MET: '기한 내 완료',
  BREACHED: '기한 초과 완료',
});

/** 긴급도별 목표(업무 시간, 분) */
export function targetMinutes(priority, cfg) {
  const t = cfg.targets[priority];
  if (!t) throw new RangeError(`알 수 없는 긴급도: ${priority}`);
  if (t.hours !== undefined) return t.hours * 60;
  return t.businessDays * workdayMinutes(cfg);
}

/** 기한 = 접수 시각부터 (목표 + 멈춘 시간) 만큼 업무 시간이 흐른 시각 */
export function computeDueAt(createdAt, priority, pausedMinutes, cfg) {
  return addBusinessMinutes(createdAt, targetMinutes(priority, cfg) + pausedMinutes, cfg);
}

/**
 * 보류 → 재개할 때 새 멈춘 시간 합계와 새 기한
 * @param {{createdAt: Date, priority: string, pausedMinutes: number, holdStartedAt: Date}} t
 */
export function resumeSla(t, now, cfg) {
  // 분 단위로 반올림해 저장한다 (sla_paused_minutes 는 정수 열)
  const added = Math.round(businessMinutesBetween(t.holdStartedAt, now, cfg));
  const pausedMinutes = t.pausedMinutes + added;
  return { addedMinutes: added, pausedMinutes, dueAt: computeDueAt(t.createdAt, t.priority, pausedMinutes, cfg) };
}

/**
 * 지금 기준 SLA 상태
 * @param {{status: string, priority: string, dueAt: Date, resolvedAt?: Date|null}} t
 * @returns {{state: keyof SLA_STATES, remainingMinutes: number|null}}
 */
export function slaState(t, now, cfg) {
  if (t.status === 'RESOLVED') {
    return { state: t.resolvedAt <= t.dueAt ? 'MET' : 'BREACHED', remainingMinutes: null };
  }
  if (t.status === 'ON_HOLD') {
    return { state: 'PAUSED', remainingMinutes: null };
  }
  if (now >= t.dueAt) {
    return { state: 'OVERDUE', remainingMinutes: 0 };
  }
  const remaining = businessMinutesBetween(now, t.dueAt, cfg);
  const imminent = remaining <= targetMinutes(t.priority, cfg) * cfg.imminentRatio;
  return { state: imminent ? 'IMMINENT' : 'ON_TRACK', remainingMinutes: remaining };
}
