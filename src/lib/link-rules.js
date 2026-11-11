// B(Uptime Monitor) 장애 링크 검증 (순수 함수)
//
// 규칙: https 이고, 설정된 B 주소와 출처(origin: 프로토콜+호스트+포트)가 같아야 한다.
// 아무 사이트 링크나 저장할 수 있으면, 피싱 링크를 티켓에 심는 데 악용될 수 있다.
// 빈 값은 "링크 삭제"로 본다.

export const MAX_LINK_LENGTH = 500;

/**
 * @param {unknown} value 사용자가 입력한 링크
 * @param {string | undefined} baseUrl wrangler.jsonc 의 UPTIME_MONITOR_BASE_URL
 * @returns {{ok: true, value: string | null} | {ok: false, message: string}}
 */
export function validateIncidentLink(value, baseUrl) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') return { ok: false, message: '링크는 문자열이어야 합니다' };

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, message: 'Uptime Monitor 주소가 설정되지 않았습니다' };
  }

  const text = value.trim();
  if (text.length > MAX_LINK_LENGTH) return { ok: false, message: `링크는 ${MAX_LINK_LENGTH}자 이하여야 합니다` };

  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: '올바른 URL 형식이 아닙니다' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'https 링크만 저장할 수 있습니다' };
  if (url.origin !== base.origin) {
    return { ok: false, message: `Uptime Monitor(${base.origin}) 링크만 저장할 수 있습니다` };
  }
  if (url.username || url.password) return { ok: false, message: '계정 정보가 들어간 링크는 저장할 수 없습니다' };
  return { ok: true, value: url.href };
}
