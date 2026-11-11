// 토큰 생성·해시·비교 도우미.
// Web Crypto(globalThis.crypto)만 쓰므로 Workers와 Node(테스트) 양쪽에서 똑같이 동작한다.

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 무작위 토큰 (기본 32바이트 → 16진수 64자)
export function randomTokenHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export async function sha256Hex(text) {
  return toHex(await sha256Bytes(text));
}

/**
 * 두 문자열이 같은지 "걸리는 시간이 내용과 무관하게" 비교한다.
 * 일반 비교(===)는 앞글자부터 다르면 바로 끝나서, 응답 시간 차이로 토큰을 한 글자씩
 * 추측하는 공격(타이밍 공격)에 이론상 노출된다. 그래서 두 값을 같은 길이의 해시로 바꾼 뒤
 * 모든 바이트를 끝까지 비교한다.
 */
export async function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}
