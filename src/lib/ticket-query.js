// 티켓 SQL 만들기 (순수 함수). 값은 전부 ? 바인딩으로만 넘긴다.

import { isCategory, isPriority, isStatus } from './ticket-rules.js';
import { escapeLike } from './sql-util.js';

// 변경 가능한 열 (작업 계획의 changes 키는 이 목록에 있어야 한다)
const UPDATABLE_COLUMNS = new Set([
  'status',
  'assignee_emp_no',
  'sla_due_at',
  'sla_paused_minutes',
  'hold_started_at',
  'resolved_at',
  'cause',
  'action_taken',
  'verification',
  'incident_url',
  'asset_id',
]);

const SLA_FILTERS = new Set(['OVERDUE', 'IMMINENT']);

/**
 * 목록 필터 검증. 직원은 자기 요청만 보도록 requesterEmpNo 를 강제로 넣는다.
 * @param {URLSearchParams} params
 * @param {{isItStaff: boolean, empNo: string}} viewer
 */
export function parseListFilters(params, viewer) {
  const errors = [];
  const get = (k) => {
    const v = params.get(k);
    return v === null || v.trim() === '' ? null : v.trim();
  };
  const filters = {
    status: get('status'),
    category: get('category'),
    priority: get('priority'),
    assignee: get('assignee'),
    sla: get('sla'),
    q: get('q'),
    requesterEmpNo: null,
  };
  if (filters.status && filters.status !== 'OPEN' && !isStatus(filters.status)) errors.push('status');
  if (filters.category && !isCategory(filters.category)) errors.push('category');
  if (filters.priority && !isPriority(filters.priority)) errors.push('priority');
  if (filters.assignee && filters.assignee !== 'NONE' && !/^DT-\d{4}$/.test(filters.assignee)) errors.push('assignee');
  if (filters.sla && !SLA_FILTERS.has(filters.sla)) errors.push('sla');
  if (filters.q && filters.q.length > 100) errors.push('q');

  // 직원(IT 담당자가 아님)은 어떤 파라미터를 보내도 자기 요청만 본다
  if (!viewer.isItStaff) {
    filters.requesterEmpNo = viewer.empNo;
    filters.assignee = null;
  }
  return { ok: errors.length === 0, errors, filters };
}

export const TICKET_SELECT = `
  SELECT t.*,
         r.name AS requester_name, rd.name AS requester_dept,
         a.name AS assignee_name,
         (SELECT f.id FROM faq_articles f WHERE f.source_ticket_id = t.id) AS faq_id,
         ast.asset_tag AS asset_tag, ast.asset_type AS asset_type, ast.model AS asset_model, ast.location AS asset_location
    FROM tickets t
    JOIN employees r ON r.emp_no = t.requester_emp_no
    JOIN departments rd ON rd.code = r.dept_code
    LEFT JOIN employees a ON a.emp_no = t.assignee_emp_no
    LEFT JOIN assets ast ON ast.id = t.asset_id`;

/** 목록 조회 SQL (SLA 필터는 계산이 필요해 호출하는 쪽에서 거른다) */
export function buildListQuery(filters, limit = 200) {
  const where = [];
  const params = [];
  if (filters.requesterEmpNo) {
    where.push('t.requester_emp_no = ?');
    params.push(filters.requesterEmpNo);
  }
  if (filters.status === 'OPEN') {
    where.push("t.status <> 'RESOLVED'");
  } else if (filters.status) {
    where.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.category) {
    where.push('t.category = ?');
    params.push(filters.category);
  }
  if (filters.priority) {
    where.push('t.priority = ?');
    params.push(filters.priority);
  }
  if (filters.assignee === 'NONE') {
    where.push('t.assignee_emp_no IS NULL');
  } else if (filters.assignee) {
    where.push('t.assignee_emp_no = ?');
    params.push(filters.assignee);
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.symptom LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  const sql =
    TICKET_SELECT +
    (where.length ? `\n   WHERE ${where.join('\n     AND ')}` : '') +
    `\n   ORDER BY t.id DESC\n   LIMIT ${Number(limit) | 0}`;
  return { sql, params };
}

const EVENT_COLUMNS = 'ticket_id, event_type, actor_emp_no, from_status, to_status, note, data, created_at';

function eventValues(ev, ticketIdSql, actorEmpNo, nowIso) {
  return [ev.eventType, actorEmpNo, ev.fromStatus ?? null, ev.toStatus ?? null, ev.note ?? null, ev.data ? JSON.stringify(ev.data) : null, nowIso];
}

/**
 * 접수: 티켓 INSERT 와 CREATED 이력을 한 batch 로.
 * 이력의 ticket_id 는 같은 batch 안의 last_insert_rowid() 로 잇는다.
 */
export function buildCreateStatements(row, events, actorEmpNo, nowIso) {
  const cols = Object.keys(row);
  return [
    {
      sql: `INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      params: cols.map((c) => row[c]),
    },
    ...events.map((ev) => ({
      sql: `INSERT INTO ticket_events (${EVENT_COLUMNS}) VALUES (last_insert_rowid(), ?, ?, ?, ?, ?, ?, ?)`,
      params: eventValues(ev, null, actorEmpNo, nowIso),
    })),
  ];
}

/**
 * 작업 계획을 SQL 로. 낙관적 잠금(version)을 쓴다:
 * 1) UPDATE … SET write_token = <이 요청만의 무작위 값> WHERE id = ? AND version = <읽을 때 버전>
 *    → 그 사이 누가 바꿨으면 0건
 * 2) 이력·FAQ INSERT 는 "write_token 이 이 요청의 값일 때만" 들어가게 WHERE EXISTS 로 막는다.
 *    ("버전 = 읽을 때 + 1" 로 검사하면, 다른 요청이 먼저 버전을 올린 경우에도 참이 되어
 *     이력만 잘못 들어간다. 테스트로 확인한 문제라 요청별 토큰으로 바꿨다.)
 * 호출하는 쪽은 1번의 changes 가 1이 아니면 409(충돌)로 응답한다.
 */
export function buildCommandStatements(ticket, plan, actorEmpNo, nowIso, writeToken) {
  if (typeof writeToken !== 'string' || writeToken.length < 16) throw new Error('writeToken 이 필요합니다');
  const sets = [];
  const params = [];
  for (const [col, value] of Object.entries(plan.changes)) {
    if (!UPDATABLE_COLUMNS.has(col)) throw new Error(`변경할 수 없는 열: ${col}`);
    sets.push(`${col} = ?`);
    params.push(value);
  }
  sets.push('updated_at = ?', 'version = version + 1', 'write_token = ?');
  params.push(nowIso, writeToken, ticket.id, ticket.version);

  const guard = 'WHERE EXISTS (SELECT 1 FROM tickets WHERE id = ? AND write_token = ?)';
  const guardParams = [ticket.id, writeToken];

  const statements = [{ sql: `UPDATE tickets SET ${sets.join(', ')} WHERE id = ? AND version = ?`, params }];
  for (const ev of plan.events) {
    statements.push({
      sql: `INSERT INTO ticket_events (${EVENT_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ? ${guard}`,
      params: [ticket.id, ...eventValues(ev, ticket.id, actorEmpNo, nowIso), ...guardParams],
    });
  }
  if (plan.faq) {
    statements.push({
      sql:
        'INSERT INTO faq_articles (source_ticket_id, category, title, question, answer, published_by, created_at) ' +
        `SELECT ?, ?, ?, ?, ?, ?, ? ${guard}`,
      params: [ticket.id, plan.faq.category, plan.faq.title, plan.faq.question, plan.faq.answer, actorEmpNo, nowIso, ...guardParams],
    });
  }
  return statements;
}
