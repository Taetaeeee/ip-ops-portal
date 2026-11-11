// 헬프데스크 규칙 (순수 함수): 분류·긴급도·상태 상수, 상태 전이, 입력 검증

export const CATEGORIES = Object.freeze({
  NETWORK: '네트워크',
  PC: 'PC',
  ACCOUNT: '계정',
  PRINTER: '프린터',
  SOFTWARE: '소프트웨어',
  SECURITY: '보안',
});

export const PRIORITIES = Object.freeze({
  URGENT: '긴급',
  HIGH: '높음',
  NORMAL: '보통',
  LOW: '낮음',
});

export const STATUSES = Object.freeze({
  RECEIVED: '접수',
  ASSIGNED: '배정',
  IN_PROGRESS: '처리 중',
  ON_HOLD: '보류',
  RESOLVED: '완료',
});

// 허용되는 상태 전이. 여기 없는 전이는 전부 거부한다.
// 완료(RESOLVED)는 마지막 상태라 나가는 전이가 없다.
export const TRANSITIONS = Object.freeze({
  RECEIVED: Object.freeze(['ASSIGNED']),
  ASSIGNED: Object.freeze(['IN_PROGRESS']),
  IN_PROGRESS: Object.freeze(['ON_HOLD', 'RESOLVED']),
  ON_HOLD: Object.freeze(['IN_PROGRESS']),
  RESOLVED: Object.freeze([]),
});

// 입력 길이 제한 (글자 수)
export const LIMITS = Object.freeze({
  title: 100,
  symptom: 2000,
  note: 2000,
  cause: 1000,
  action: 1000,
  verification: 1000,
  faqTitle: 100,
  faqQuestion: 2000,
  faqAnswer: 4000,
});

const has = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

export const isCategory = (v) => has(CATEGORIES, v);
export const isPriority = (v) => has(PRIORITIES, v);
export const isStatus = (v) => has(STATUSES, v);

export function canTransition(from, to) {
  return isStatus(from) && isStatus(to) && TRANSITIONS[from].includes(to);
}

/**
 * 문자열 입력 정리: 앞뒤 공백 제거. 비었거나 너무 길면 오류 메시지를 errors 에 넣는다.
 * 공백만 입력한 값도 "비어 있음"으로 본다.
 */
export function cleanText(value, { field, label, max, required = true }, errors) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    errors.push({ field, message: `${label}은(는) 문자열이어야 합니다` });
    return null;
  }
  const text = value.trim();
  if (text === '') {
    if (required) errors.push({ field, message: `${label}을(를) 입력해야 합니다` });
    return null;
  }
  if (text.length > max) {
    errors.push({ field, message: `${label}은(는) ${max}자 이하여야 합니다` });
    return null;
  }
  return text;
}

/** 새 요청 접수 입력 검증 */
export function validateNewTicket(input) {
  const errors = [];
  const body = input && typeof input === 'object' ? input : {};
  if (!isCategory(body.category)) errors.push({ field: 'category', message: '분류를 골라야 합니다' });
  if (!isPriority(body.priority)) errors.push({ field: 'priority', message: '긴급도를 골라야 합니다' });
  const title = cleanText(body.title, { field: 'title', label: '제목', max: LIMITS.title }, errors);
  const symptom = cleanText(body.symptom, { field: 'symptom', label: '증상', max: LIMITS.symptom }, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { category: body.category, priority: body.priority, title, symptom } };
}

/** 완료 입력 검증: 원인·조치·검증 결과가 모두 있어야 한다 */
export function validateResolution(input) {
  const errors = [];
  const body = input && typeof input === 'object' ? input : {};
  const cause = cleanText(body.cause, { field: 'cause', label: '원인', max: LIMITS.cause }, errors);
  const action = cleanText(body.action, { field: 'action', label: '조치', max: LIMITS.action }, errors);
  const verification = cleanText(
    body.verification,
    { field: 'verification', label: '검증 결과', max: LIMITS.verification },
    errors,
  );
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { cause, action, verification } };
}

/** 티켓 번호 표시: 1 → HD-0001 */
export function ticketNo(id) {
  return `HD-${String(id).padStart(4, '0')}`;
}
