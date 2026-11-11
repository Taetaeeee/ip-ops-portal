// HTTP 응답 공통 도우미

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 개인 화면 데이터가 중간 캐시에 남지 않게
  'cache-control': 'no-store',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// 오류 응답 형식: { error: { code, message } }
export function error(status, code, message, extraHeaders = {}) {
  return json({ error: { code, message } }, status, extraHeaders);
}

/**
 * JSON 본문을 읽는다. Content-Type 이 application/json 이 아니면 거부한다.
 * 다른 사이트의 <form>은 application/json 으로 보낼 수 없으므로, 이 검사가 CSRF를 한 번 더 막는다.
 * @returns {Promise<{ok: true, body: any} | {ok: false, response: Response}>}
 */
export async function readJson(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json 이 필요합니다') };
  }
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: error(400, 'INVALID_JSON', 'JSON 본문을 해석할 수 없습니다') };
  }
}
