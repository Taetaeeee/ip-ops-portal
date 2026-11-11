// SLA·업무 시간 설정값.
// 계산 함수는 이 객체를 인자로 받는다. 테스트에서는 다른 설정을 넣어 볼 수 있다.

export const SLA_CONFIG = Object.freeze({
  // 한국 표준시(KST) = UTC+9. 한국은 서머타임이 없어 고정 오프셋으로 충분하다.
  timezoneOffsetMinutes: 9 * 60,

  // 업무 시간: 09:00 ~ 18:00 (점심시간 포함, 하루 9시간)
  workdayStartHour: 9,
  workdayEndHour: 18,

  // 업무 요일: 0=일, 1=월 … 6=토
  workdays: Object.freeze([1, 2, 3, 4, 5]),

  // 공휴일(KST 날짜 'YYYY-MM-DD'). 해마다 바뀌어(대체공휴일 등) 지금은 비워 둔다.
  holidays: Object.freeze([]),

  // 긴급도별 처리 목표. hours = 업무 시간, businessDays = 영업일(하루 = 업무 시간 길이)
  targets: Object.freeze({
    URGENT: Object.freeze({ hours: 4 }),
    HIGH: Object.freeze({ hours: 8 }),
    NORMAL: Object.freeze({ businessDays: 1 }),
    LOW: Object.freeze({ businessDays: 3 }),
  }),

  // 남은 업무 시간이 목표의 25% 이하이면 "임박"
  imminentRatio: 0.25,
});
