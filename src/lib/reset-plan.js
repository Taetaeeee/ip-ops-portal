// 데모 초기화 계획을 만드는 순수 함수.
// 시드 데이터를 "지우기 → 넣기" 순서의 SQL 문 목록으로 바꾼다. 실행은 src/reset.js 가 한다.
//
// - 값은 전부 ? 자리표시자(바인딩 매개변수)로 넘긴다. SQL 문자열에 값을 이어 붙이지 않으므로
//   이름에 따옴표가 있어도 SQL 주입이 생기지 않는다.
// - 테이블·열 이름은 아래 상수에서만 오며, 사용자 입력이 들어가지 않는다.
// - 여러 행을 한 INSERT 로 묶어 문장 수를 줄인다 (문장당 매개변수 100개 이하).

import { buildInsertStatements } from './sql-util.js';

// 지우는 순서: 다른 테이블이 참조하는 쪽(부모)을 나중에 지운다.
// faq_articles·ticket_events → tickets → employees → departments → sites
export const DELETE_ORDER = Object.freeze([
  'sessions',
  'faq_articles',
  'ticket_events',
  'tickets',
  'employees',
  'departments',
  'sites',
]);

// 넣는 순서(부모 → 자식)와 각 테이블의 열
export const INSERT_COLUMNS = Object.freeze({
  sites: ['code', 'name', 'kind', 'sort_order'],
  departments: ['code', 'name', 'site_code', 'sort_order'],
  employees: ['emp_no', 'name', 'dept_code', 'job_title', 'is_team_lead', 'duty', 'hire_date', 'extension'],
  tickets: [
    'id', 'requester_emp_no', 'category', 'priority', 'title', 'symptom', 'status', 'assignee_emp_no',
    'created_at', 'updated_at', 'sla_due_at', 'sla_paused_minutes', 'hold_started_at', 'resolved_at',
    'cause', 'action_taken', 'verification', 'incident_url', 'version',
  ],
  ticket_events: ['ticket_id', 'event_type', 'actor_emp_no', 'from_status', 'to_status', 'note', 'data', 'created_at'],
  faq_articles: ['id', 'source_ticket_id', 'category', 'title', 'question', 'answer', 'published_by', 'created_at'],
});

const EMPTY_HELPDESK = Object.freeze({ tickets: [], events: [], faqs: [] });

/**
 * @param {{sites: any[], departments: any[], employees: any[]}} data generateSeedData() 결과
 * @param {{tickets: any[], events: any[], faqs: any[]}} helpdesk generateDemoTickets() 결과
 * @returns {{sql: string, params: any[]}[]}
 */
export function buildResetStatements(data, helpdesk = EMPTY_HELPDESK) {
  const rows = {
    sites: data.sites.map((s) => [s.code, s.name, s.kind, s.sortOrder]),
    departments: data.departments.map((d) => [d.code, d.name, d.siteCode, d.sortOrder]),
    employees: data.employees.map((e) => [
      e.empNo, e.name, e.deptCode, e.jobTitle, e.isTeamLead ? 1 : 0, e.duty, e.hireDate, e.extension,
    ]),
    tickets: helpdesk.tickets.map((t) => [
      t.id, t.requesterEmpNo, t.category, t.priority, t.title, t.symptom, t.status, t.assigneeEmpNo,
      t.createdAt, t.updatedAt, t.slaDueAt, t.slaPausedMinutes, t.holdStartedAt, t.resolvedAt,
      t.cause, t.actionTaken, t.verification, t.incidentUrl, t.version,
    ]),
    ticket_events: helpdesk.events.map((e) => [
      e.ticketId, e.eventType, e.actorEmpNo, e.fromStatus, e.toStatus, e.note, e.data, e.createdAt,
    ]),
    faq_articles: helpdesk.faqs.map((f) => [
      f.id, f.sourceTicketId, f.category, f.title, f.question, f.answer, f.publishedBy, f.createdAt,
    ]),
  };

  const statements = DELETE_ORDER.map((table) => ({ sql: `DELETE FROM ${table}`, params: [] }));
  for (const [table, columns] of Object.entries(INSERT_COLUMNS)) {
    statements.push(...buildInsertStatements(table, columns, rows[table]));
  }
  return statements;
}
