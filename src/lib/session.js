// 데모 로그인 세션의 규칙(순수 함수). DB 저장·조회는 src/auth.js 가 한다.
//
// 쿠키 속성 설명:
// - HttpOnly : 화면의 자바스크립트가 쿠키를 읽지 못하게 한다 (XSS로 세션을 훔치기 어렵게)
// - Secure   : HTTPS에서만 보낸다 (브라우저는 localhost를 예외적으로 안전한 곳으로 본다)
// - SameSite=Lax : 다른 사이트에서 몰래 보내는 POST 요청에는 쿠키를 붙이지 않는다 (CSRF 완화)

export const SESSION_COOKIE = 'ops_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8시간 (근무 시간 기준)

// 데모 페르소나. 비밀번호 없이 고르는 방식이다.
export const PERSONAS = Object.freeze({
  it_admin: { label: 'IT 담당자', description: '경영지원팀 · 전산·IT 운영 담당' },
  employee: { label: '일반 직원', description: '영업팀 직원' },
});

export function isValidPersona(persona) {
  return typeof persona === 'string' && Object.hasOwn(PERSONAS, persona);
}

// 세션 토큰은 32바이트 무작위 값의 16진수(64자)
export function isValidTokenFormat(token) {
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token);
}

export function computeExpiry(now, ttlSeconds = SESSION_TTL_SECONDS) {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

// 만료 시각을 해석할 수 없으면 안전하게 "만료됨"으로 본다
export function isSessionExpired(expiresAtIso, now) {
  const t = Date.parse(expiresAtIso);
  return !Number.isFinite(t) || t <= now.getTime();
}

export function buildSessionCookie(token, maxAgeSeconds = SESSION_TTL_SECONDS) {
  if (!isValidTokenFormat(token)) throw new Error('잘못된 세션 토큰 형식');
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function buildClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// "a=1; b=2" 형태의 Cookie 헤더를 객체로 바꾼다
export function parseCookies(header) {
  const result = {};
  if (typeof header !== 'string' || header === '') return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !Object.hasOwn(result, name)) result[name] = value;
  }
  return result;
}
