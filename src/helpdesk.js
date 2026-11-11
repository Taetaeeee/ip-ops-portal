// 헬프데스크 API 처리 (D1 사용).
// 규칙·계산은 src/lib/ 의 순수 함수가 하고, 여기서는 읽기 → 계획 → 저장만 한다.

import { json, readJson } from './http.js';
import { requireSession, isItStaff } from './auth.js';
import { SLA_CONFIG } from './lib/sla-config.js';
import { slaState, targetMinutes, SLA_STATES } from './lib/sla.js';
import { CATEGORIES, PRIORITIES, STATUSES, TRANSITIONS, LIMITS, ticketNo } from './lib/ticket-rules.js';
import {
  planCreate,
  planAssign,
  planStatusChange,
  planNote,
  planLinkChange,
  planFaq,
  buildFaqDraft,
} from './lib/ticket-commands.js';
import {
  TICKET_SELECT,
  parseListFilters,
  buildListQuery,
  buildCreateStatements,
  buildCommandStatements,
} from './lib/ticket-query.js';
import { ASSIGNEE_DUTIES } from './lib/seed-data.js';
import { randomTokenHex } from './lib/crypto-util.js';

// 오류 응답 (검증 오류 목록 포함)
function fail(status, code, message, errors) {
  return json({ error: { code, message, ...(errors ? { errors } : {}) } }, status);
}

const toDate = (v) => (v ? new Date(v) : null);

function rowToTicket(row) {
  return {
    id: row.id,
    requesterEmpNo: row.requester_emp_no,
    category: row.category,
    priority: row.priority,
    title: row.title,
    symptom: row.symptom,
    status: row.status,
    assigneeEmpNo: row.assignee_emp_no,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    slaDueAt: toDate(row.sla_due_at),
    slaPausedMinutes: row.sla_paused_minutes,
    holdStartedAt: toDate(row.hold_started_at),
    resolvedAt: toDate(row.resolved_at),
    cause: row.cause,
    actionTaken: row.action_taken,
    verification: row.verification,
    incidentUrl: row.incident_url,
    version: row.version,
  };
}

function ticketDto(row, now) {
  const t = rowToTicket(row);
  const sla = slaState({ status: t.status, priority: t.priority, dueAt: t.slaDueAt, resolvedAt: t.resolvedAt }, now, SLA_CONFIG);
  return {
    id: t.id,
    ticketNo: ticketNo(t.id),
    category: t.category,
    priority: t.priority,
    title: t.title,
    symptom: t.symptom,
    status: t.status,
    requester: { empNo: t.requesterEmpNo, name: row.requester_name, department: row.requester_dept },
    assignee: t.assigneeEmpNo ? { empNo: t.assigneeEmpNo, name: row.assignee_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    holdStartedAt: row.hold_started_at,
    sla: { ...sla, dueAt: row.sla_due_at, pausedMinutes: t.slaPausedMinutes },
    resolution: t.status === 'RESOLVED' ? { cause: t.cause, action: t.actionTaken, verification: t.verification } : null,
    incidentUrl: t.incidentUrl,
    faqId: row.faq_id ?? null,
  };
}

async function loadTicketRow(env, id) {
  return env.DB.prepare(`${TICKET_SELECT}\n   WHERE t.id = ?`).bind(id).first();
}

async function loadAssignees(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.emp_no, e.name, e.job_title, e.duty
       FROM employees e WHERE e.duty IN (${ASSIGNEE_DUTIES.map(() => '?').join(', ')})
      ORDER BY e.emp_no DESC`,
  )
    .bind(...ASSIGNEE_DUTIES)
    .all();
  return results.map((r) => ({ empNo: r.emp_no, name: r.name, jobTitle: r.job_title, duty: r.duty }));
}

// 직원은 자기 요청만. 남의 티켓은 404 로 응답해 존재 여부도 알려 주지 않는다.
function canView(session, row) {
  return isItStaff(session) || row.requester_emp_no === session.employee.empNo;
}

async function ticketDetail(env, id, session) {
  const row = await loadTicketRow(env, id);
  if (!row || !canView(session, row)) return null;
  const now = new Date();
  const { results } = await env.DB.prepare(
    `SELECT ev.id, ev.event_type, ev.from_status, ev.to_status, ev.note, ev.data, ev.created_at,
            ev.actor_emp_no, a.name AS actor_name
       FROM ticket_events ev JOIN employees a ON a.emp_no = ev.actor_emp_no
      WHERE ev.ticket_id = ?
      ORDER BY ev.created_at, ev.id`,
  )
    .bind(id)
    .all();

  const ticket = ticketDto(row, now);
  const staff = isItStaff(session);
  return {
    ticket,
    events: results.map((e) => ({
      id: e.id,
      type: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      note: e.note,
      data: safeJson(e.data),
      createdAt: e.created_at,
      actor: { empNo: e.actor_emp_no, name: e.actor_name },
    })),
    allowedTransitions: staff ? TRANSITIONS[ticket.status].filter((s) => s !== 'ASSIGNED') : [],
    faqDraft: staff && ticket.status === 'RESOLVED' && !ticket.faqId ? buildFaqDraft(rowToTicket(row)) : null,
  };
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseId(params) {
  const id = Number(params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ───────────────────────── 조회 ─────────────────────────

export async function handleMeta(request, env) {
  const auth = await requireSession(env, request);
  if (auth.response) return auth.response;
  return json({
    categories: CATEGORIES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    transitions: TRANSITIONS,
    slaStates: SLA_STATES,
    limits: LIMITS,
    sla: {
      businessHours: { start: SLA_CONFIG.workdayStartHour, end: SLA_CONFIG.workdayEndHour, workdays: SLA_CONFIG.workdays },
      targetMinutes: Object.fromEntries(Object.keys(PRIORITIES).map((p) => [p, targetMinutes(p, SLA_CONFIG)])),
      imminentRatio: SLA_CONFIG.imminentRatio,
    },
    assignees: await loadAssignees(env),
    incidentBaseUrl: env.UPTIME_MONITOR_BASE_URL ?? null,
    viewer: { isItStaff: isItStaff(auth.session), empNo: auth.session.employee.empNo },
  });
}

export async function handleList(request, env) {
  const auth = await requireSession(env, request);
  if (auth.response) return auth.response;
  const viewer = { isItStaff: isItStaff(auth.session), empNo: auth.session.employee.empNo };
  const parsed = parseListFilters(new URL(request.url).searchParams, viewer);
  if (!parsed.ok) return fail(400, 'INVALID_FILTER', `잘못된 필터: ${parsed.errors.join(', ')}`);

  const { sql, params } = buildListQuery(parsed.filters);
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const now = new Date();
  let tickets = results.map((r) => ticketDto(r, now));
  if (parsed.filters.sla) tickets = tickets.filter((t) => t.sla.state === parsed.filters.sla);
  return json({ tickets, count: tickets.length, now: now.toISOString() });
}

export async function handleDetail(request, env, params) {
  const auth = await requireSession(env, request);
  if (auth.response) return auth.response;
  const id = parseId(params);
  const detail = id && (await ticketDetail(env, id, auth.session));
  if (!detail) return fail(404, 'NOT_FOUND', '티켓을 찾을 수 없습니다');
  return json(detail);
}

// ───────────────────────── 접수 ─────────────────────────

export async function handleCreate(request, env) {
  const auth = await requireSession(env, request);
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;

  const now = new Date();
  const actor = auth.session.employee.empNo;
  const plan = planCreate(body.body, { now, requesterEmpNo: actor, cfg: SLA_CONFIG });
  if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.message, plan.errors);

  const stmts = buildCreateStatements(plan.row, plan.events, actor, now.toISOString());
  const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  const id = results[0].meta.last_row_id;
  return json({ ok: true, id, ticketNo: ticketNo(id) }, 201);
}

// ───────────────────────── IT 담당자 작업 ─────────────────────────

/**
 * 공통 흐름: 로그인(IT 담당자) → 본문 읽기 → 티켓 읽기 → 계획 → 저장 → 최신 상세 응답
 * @param {(ticket, body, ctx) => object} makePlan
 */
async function runCommand(request, env, params, makePlan) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const id = parseId(params);
  const row = id && (await loadTicketRow(env, id));
  if (!row) return fail(404, 'NOT_FOUND', '티켓을 찾을 수 없습니다');

  const now = new Date();
  const ticket = rowToTicket(row);
  const plan = await makePlan(ticket, body.body, { now, cfg: SLA_CONFIG, row });
  if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.message, plan.errors);

  const writeToken = randomTokenHex(16);
  const stmts = buildCommandStatements(ticket, plan, auth.session.employee.empNo, now.toISOString(), writeToken);
  let results;
  try {
    results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return fail(409, 'CONFLICT', '이미 처리된 요청입니다');
    throw err;
  }
  if (results[0].meta.changes !== 1) {
    return fail(409, 'CONFLICT', '그 사이 다른 사람이 티켓을 바꿨습니다. 새로고침 후 다시 시도하세요');
  }
  return json(await ticketDetail(env, id, auth.session));
}

export const handleAssign = (request, env, params) =>
  runCommand(request, env, params, async (ticket, body) => {
    const assignees = await loadAssignees(env);
    return planAssign(ticket, body, { assigneeEmpNos: assignees.map((a) => a.empNo) });
  });

export const handleStatus = (request, env, params) =>
  runCommand(request, env, params, (ticket, body, ctx) => planStatusChange(ticket, body, ctx));

export const handleNote = (request, env, params) =>
  runCommand(request, env, params, (ticket, body) => planNote(ticket, body));

export const handleIncidentLink = (request, env, params) =>
  runCommand(request, env, params, (ticket, body) => planLinkChange(ticket, body, { baseUrl: env.UPTIME_MONITOR_BASE_URL }));

export const handleFaqCreate = (request, env, params) =>
  runCommand(request, env, params, (ticket, body, ctx) => planFaq(ticket, body, { hasFaq: ctx.row.faq_id != null }));

// ───────────────────────── FAQ ─────────────────────────

export async function handleFaqList(request, env) {
  const auth = await requireSession(env, request);
  if (auth.response) return auth.response;
  const { results } = await env.DB.prepare(
    `SELECT id, source_ticket_id, category, title, question, answer, created_at
       FROM faq_articles ORDER BY category, id DESC`,
  ).all();
  const staff = isItStaff(auth.session);
  return json({
    faqs: results.map((f) => ({
      id: f.id,
      category: f.category,
      title: f.title,
      question: f.question,
      answer: f.answer,
      createdAt: f.created_at,
      // 원본 티켓 번호는 IT 담당자에게만 (직원은 남의 티켓을 볼 수 없으므로)
      sourceTicket: staff ? { id: f.source_ticket_id, ticketNo: ticketNo(f.source_ticket_id) } : null,
    })),
  });
}
