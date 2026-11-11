// 업무 시간 계산 (순수 함수).
//
// 방식: UTC 시각에 KST 오프셋을 더한 "벽시계 밀리초(wall)"로 바꿔서 하루 단위로 걷는다.
// 각 업무일의 업무 구간 [시작, 끝] 과 겹치는 부분만 센다. 주말·공휴일은 건너뛴다.
// 하루씩 걷는 방식이라 느려 보이지만, SLA 기한은 길어야 몇 주라 충분히 빠르고
// 경계 조건(금요일 17시, 18시 정각 등)을 이해하기 쉽다.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_DAYS = 3660; // 무한 반복 방지 (약 10년)

function toWall(date, cfg) {
  return date.getTime() + cfg.timezoneOffsetMinutes * MINUTE;
}

function fromWall(wall, cfg) {
  return new Date(wall - cfg.timezoneOffsetMinutes * MINUTE);
}

function dayStart(wall) {
  return Math.floor(wall / DAY) * DAY;
}

function isWorkday(dayStartWall, cfg) {
  const d = new Date(dayStartWall);
  return cfg.workdays.includes(d.getUTCDay()) && !cfg.holidays.includes(d.toISOString().slice(0, 10));
}

function openClose(dayStartWall, cfg) {
  return [dayStartWall + cfg.workdayStartHour * HOUR, dayStartWall + cfg.workdayEndHour * HOUR];
}

/** 하루 업무 시간(분) */
export function workdayMinutes(cfg) {
  return (cfg.workdayEndHour - cfg.workdayStartHour) * 60;
}

/** 그 시각이 업무 시간 안인지 (시작 포함, 끝 미포함) */
export function isBusinessTime(date, cfg) {
  const wall = toWall(date, cfg);
  const ds = dayStart(wall);
  if (!isWorkday(ds, cfg)) return false;
  const [open, close] = openClose(ds, cfg);
  return wall >= open && wall < close;
}

/**
 * start 부터 업무 시간으로 minutes 분이 지난 시각.
 * 업무 시간 밖에서 시작하면 다음 업무 시작 시각부터 센다.
 * 예) 금 17:00 + 240분 → 금 1시간 + 월 3시간 → 월 12:00
 */
export function addBusinessMinutes(start, minutes, cfg) {
  if (!(minutes >= 0)) throw new RangeError('minutes 는 0 이상이어야 합니다');
  let wall = toWall(start, cfg);
  let remaining = minutes;
  let ds = dayStart(wall);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (isWorkday(ds, cfg)) {
      const [open, close] = openClose(ds, cfg);
      const from = Math.max(wall, open);
      if (from < close) {
        const available = (close - from) / MINUTE;
        if (remaining <= available) return fromWall(from + remaining * MINUTE, cfg);
        remaining -= available;
      }
    }
    ds += DAY;
    wall = ds;
  }
  throw new RangeError('업무 시간 계산 범위를 넘었습니다');
}

/**
 * end 에서 업무 시간으로 minutes 분 거슬러 올라간 시각. (데모 데이터 생성용)
 */
export function subtractBusinessMinutes(end, minutes, cfg) {
  if (!(minutes >= 0)) throw new RangeError('minutes 는 0 이상이어야 합니다');
  let wall = toWall(end, cfg);
  let remaining = minutes;
  let ds = dayStart(wall);
  for (let i = 0; i < MAX_DAYS; i++) {
    if (isWorkday(ds, cfg)) {
      const [open, close] = openClose(ds, cfg);
      const to = Math.min(wall, close);
      if (to > open) {
        const available = (to - open) / MINUTE;
        if (remaining <= available) return fromWall(to - remaining * MINUTE, cfg);
        remaining -= available;
      }
    }
    wall = ds;
    ds -= DAY;
  }
  throw new RangeError('업무 시간 계산 범위를 넘었습니다');
}

/**
 * a 와 b 사이의 업무 시간(분). a >= b 이면 0.
 */
export function businessMinutesBetween(a, b, cfg) {
  const startWall = toWall(a, cfg);
  const endWall = toWall(b, cfg);
  if (endWall <= startWall) return 0;
  let total = 0;
  let ds = dayStart(startWall);
  for (let i = 0; i < MAX_DAYS && ds < endWall; i++) {
    if (isWorkday(ds, cfg)) {
      const [open, close] = openClose(ds, cfg);
      const from = Math.max(startWall, open);
      const to = Math.min(endWall, close);
      if (to > from) total += (to - from) / MINUTE;
    }
    ds += DAY;
  }
  return total;
}
