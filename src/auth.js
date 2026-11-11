// 데모 로그인 세션 저장·조회와 관리자 토큰 확인 (D1 사용)
// 판정 규칙은 src/lib/session.js 의 순수 함수에 있다.

import {
  SESSION_COOKIE,
  PERSONAS,
  computeExpiry,
  isSessionExpired,
  isValidTokenFormat,
  parseCookies,
} from './lib/session.js';
import { PERSONA_EMP_NO } from './lib/seed-data.js';
import { randomTokenHex, sha256Hex, constantTimeEqual } from './lib/crypto-util.js';
import { error } from './http.js';

/**
 * 세션을 만든다. persona 는 호출 전에 isValidPersona 로 검증돼 있어야 한다.
 * @returns {Promise<{token: string} | null>} 페르소나 직원이 DB에 없으면(초기화 전) null
 */
export async function createSession(env, persona, now = new Date()) {
  const empNo = PERSONA_EMP_NO[persona];
  const exists = await env.DB.prepare('SELECT 1 FROM employees WHERE emp_no = ?').bind(empNo).first();
  if (!exists) return null;

  const token = randomTokenHex();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, persona, emp_no, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), persona, empNo, now.toISOString(), computeExpiry(now))
    .run();
  return { token };
}

function tokenFromRequest(request) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  return isValidTokenFormat(token) ? token : null;
}

/**
 * 요청의 쿠키로 현재 세션과 직원 정보를 찾는다. 없거나 만료면 null.
 */
export async function getSession(env, request, now = new Date()) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT s.persona, s.expires_at, e.emp_no, e.name, e.job_title, e.duty,
            d.name AS dept_name, st.name AS site_name
       FROM sessions s
       JOIN employees e ON e.emp_no = s.emp_no
       JOIN departments d ON d.code = e.dept_code
       JOIN sites st ON st.code = d.site_code
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;

  if (isSessionExpired(row.expires_at, now)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }

  return {
    persona: row.persona,
    personaLabel: PERSONAS[row.persona]?.label ?? row.persona,
    expiresAt: row.expires_at,
    employee: {
      empNo: row.emp_no,
      name: row.name,
      jobTitle: row.job_title,
      duty: row.duty,
      department: row.dept_name,
      site: row.site_name,
    },
  };
}

export async function deleteSession(env, request) {
  const token = tokenFromRequest(request);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

/** IT 담당자 페르소나인지 (서버에서 권한을 판단하는 유일한 기준) */
export function isItStaff(session) {
  return session?.persona === 'it_admin';
}

/**
 * 로그인 필수 도우미.
 * @returns {Promise<{session: object} | {response: Response}>}
 */
export async function requireSession(env, request, { itStaffOnly = false } = {}) {
  const session = await getSession(env, request);
  if (!session) return { response: error(401, 'UNAUTHENTICATED', '로그인이 필요합니다') };
  if (itStaffOnly && !isItStaff(session)) {
    return { response: error(403, 'FORBIDDEN', 'IT 담당자만 할 수 있는 작업입니다') };
  }
  return { session };
}

/**
 * 관리자 토큰 확인. Authorization: Bearer <ADMIN_TOKEN>
 * @returns {Promise<'ok' | 'unauthorized' | 'unconfigured'>}
 */
export async function checkAdmin(env, request) {
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length < 16) return 'unconfigured';
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return 'unauthorized';
  return (await constantTimeEqual(match[1], expected)) ? 'ok' : 'unauthorized';
}
