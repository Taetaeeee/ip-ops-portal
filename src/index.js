// Worker 진입점
// - fetch     : /api/* 요청 처리 (정적 화면 파일은 assets 설정이 먼저 처리한다)
// - scheduled : 매일 KST 04:30 데모 초기화 (wrangler.jsonc 의 triggers.crons)

import { json, error, readJson } from './http.js';
import { createSession, getSession, deleteSession, checkAdmin } from './auth.js';
import { runReset } from './reset.js';
import { isValidPersona, PERSONAS, buildSessionCookie, buildClearCookie } from './lib/session.js';
import { COMPANY } from './lib/seed-data.js';
import * as helpdesk from './helpdesk.js';
import * as assets from './assets.js';
import * as directory from './directory.js';

// [메서드, 경로 패턴, 처리 함수]. 경로의 :id 는 숫자만 받는다.
const ROUTE_TABLE = [
  ['POST', '/api/demo/login', handleLogin],
  ['POST', '/api/demo/logout', handleLogout],
  ['GET', '/api/me', handleMe],
  ['GET', '/api/org/summary', handleOrgSummary],
  ['POST', '/api/admin/reset', handleAdminReset],
  // 2단계 헬프데스크
  ['GET', '/api/helpdesk/meta', helpdesk.handleMeta],
  ['GET', '/api/tickets', helpdesk.handleList],
  ['POST', '/api/tickets', helpdesk.handleCreate],
  ['GET', '/api/tickets/:id', helpdesk.handleDetail],
  ['POST', '/api/tickets/:id/assign', helpdesk.handleAssign],
  ['POST', '/api/tickets/:id/status', helpdesk.handleStatus],
  ['POST', '/api/tickets/:id/notes', helpdesk.handleNote],
  ['PUT', '/api/tickets/:id/incident-link', helpdesk.handleIncidentLink],
  ['POST', '/api/tickets/:id/faq', helpdesk.handleFaqCreate],
  ['GET', '/api/faq', helpdesk.handleFaqList],
  ['PUT', '/api/tickets/:id/asset', helpdesk.handleTicketAsset],
  // 3단계 IT 자산·라이선스 (IT 담당자 전용)
  ['GET', '/api/assets/meta', assets.handleAssetMeta],
  ['GET', '/api/assets', assets.handleAssetList],
  ['GET', '/api/assets/:id', assets.handleAssetDetail],
  ['POST', '/api/assets/:id/assign', assets.handleAssetAssign],
  ['POST', '/api/assets/:id/return', assets.handleAssetReturn],
  ['POST', '/api/assets/:id/status', assets.handleAssetStatus],
  ['GET', '/api/licenses', assets.handleLicenses],
  // 4단계 가상 AD 디렉터리 (IT 담당자 전용)
  ['GET', '/api/directory/meta', directory.handleDirMeta],
  ['GET', '/api/directory/tree', directory.handleDirTree],
  ['GET', '/api/directory/users', directory.handleDirUsers],
  ['GET', '/api/directory/users/:id', directory.handleDirUser],
  ['POST', '/api/directory/users/:id/logon-test', directory.handleLogonTest],
  ['POST', '/api/directory/operations', directory.handleDirOperationCreate],
  ['GET', '/api/directory/operations/:id', directory.handleDirOperation],
];

// '/api/tickets/:id' → /^\/api\/tickets\/(?<id>\d+)$/
const routes = ROUTE_TABLE.map(([method, pattern, handler]) => ({
  method,
  regex: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`),
  handler,
}));

async function route(request, env) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/')) {
    return new Response('Not Found', { status: 404 });
  }
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method === request.method) return r.handler(request, env, m.groups ?? {});
  }
  return pathMatched
    ? error(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 메서드입니다')
    : error(404, 'NOT_FOUND', '없는 API입니다');
}

// 데모 로그인: 페르소나만 고른다 (비밀번호 없음)
async function handleLogin(request, env) {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const persona = parsed.body?.persona;
  if (!isValidPersona(persona)) {
    return error(400, 'INVALID_PERSONA', `페르소나는 ${Object.keys(PERSONAS).join(', ')} 중 하나여야 합니다`);
  }

  const session = await createSession(env, persona);
  if (!session) {
    return error(503, 'NOT_SEEDED', '데모 데이터가 아직 없습니다. 관리자가 초기화를 실행해야 합니다');
  }
  return json({ ok: true, persona }, 200, { 'set-cookie': buildSessionCookie(session.token) });
}

async function handleLogout(request, env) {
  await deleteSession(env, request);
  return json({ ok: true }, 200, { 'set-cookie': buildClearCookie() });
}

async function handleMe(request, env) {
  const session = await getSession(env, request);
  if (!session) return error(401, 'UNAUTHENTICATED', '로그인이 필요합니다');
  return json({ company: COMPANY, ...session });
}

// 회사 개요: 사업장 → 부서 → 인원
async function handleOrgSummary(request, env) {
  const session = await getSession(env, request);
  if (!session) return error(401, 'UNAUTHENTICATED', '로그인이 필요합니다');

  const [deptRows, lastReset] = await Promise.all([
    env.DB.prepare(
      `SELECT s.code AS site_code, s.name AS site_name, s.kind,
              d.code AS dept_code, d.name AS dept_name,
              COUNT(e.emp_no) AS headcount
         FROM sites s
         JOIN departments d ON d.site_code = s.code
         LEFT JOIN employees e ON e.dept_code = d.code
        GROUP BY s.code, d.code
        ORDER BY s.sort_order, d.sort_order`,
    ).all(),
    env.DB.prepare(
      `SELECT trigger_type, finished_at, status
         FROM reset_runs WHERE status = 'ok'
        ORDER BY id DESC LIMIT 1`,
    ).first(),
  ]);

  const sites = [];
  for (const r of deptRows.results) {
    let site = sites.at(-1);
    if (!site || site.code !== r.site_code) {
      site = { code: r.site_code, name: r.site_name, kind: r.kind, headcount: 0, departments: [] };
      sites.push(site);
    }
    site.departments.push({ code: r.dept_code, name: r.dept_name, headcount: r.headcount });
    site.headcount += r.headcount;
  }

  return json({
    company: COMPANY,
    totalHeadcount: sites.reduce((sum, s) => sum + s.headcount, 0),
    sites,
    lastReset: lastReset
      ? { trigger: lastReset.trigger_type, finishedAt: lastReset.finished_at }
      : null,
  });
}

// 수동 초기화: 관리자 토큰 필요
async function handleAdminReset(request, env) {
  const auth = await checkAdmin(env, request);
  if (auth === 'unconfigured') {
    return error(503, 'ADMIN_TOKEN_NOT_SET', 'ADMIN_TOKEN 이 설정되지 않았습니다');
  }
  if (auth !== 'ok') return error(401, 'UNAUTHORIZED', '관리자 토큰이 올바르지 않습니다');

  const result = await runReset(env, 'manual');
  return result.ok ? json(result) : error(500, 'RESET_FAILED', '초기화에 실패했습니다');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('요청 처리 중 오류', err);
      return error(500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다');
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReset(env, 'cron'));
  },
};
