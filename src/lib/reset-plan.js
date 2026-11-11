// 데모 초기화 계획을 만드는 순수 함수.
// 시드 데이터를 "지우기 → 넣기" 순서의 SQL 문 목록으로 바꾼다. 실행은 src/reset.js 가 한다.
//
// - 값은 전부 ? 자리표시자(바인딩 매개변수)로 넘긴다. SQL 문자열에 값을 이어 붙이지 않으므로
//   이름에 따옴표가 있어도 SQL 주입이 생기지 않는다.
// - 테이블·열 이름은 아래 상수에서만 오며, 사용자 입력이 들어가지 않는다.
// - 여러 행을 한 INSERT 로 묶어 문장 수를 줄인다 (문장당 매개변수 100개 이하).

import { buildInsertStatements } from './sql-util.js';

// 지우는 순서: 다른 테이블이 참조하는 쪽(자식)을 먼저, 참조되는 쪽(부모)을 나중에.
// 티켓 → 자산 참조가 있으므로 티켓을 자산보다 먼저 지운다.
export const DELETE_ORDER = Object.freeze([
  'sessions',
  'dir_events',
  'dir_operations',
  'dir_memberships',
  'dir_users',
  'dir_groups',
  'faq_articles',
  'ticket_events',
  'tickets',
  'asset_software',
  'asset_assignments',
  'software_allowlist',
  'licenses',
  'assets',
  'employees',
  'departments',
  'sites',
]);

// 넣는 순서(부모 → 자식)와 각 테이블의 열
export const INSERT_COLUMNS = Object.freeze({
  sites: ['code', 'name', 'kind', 'sort_order'],
  departments: ['code', 'name', 'site_code', 'sort_order'],
  employees: ['emp_no', 'name', 'dept_code', 'job_title', 'is_team_lead', 'duty', 'hire_date', 'extension'],
  assets: [
    'id', 'asset_tag', 'asset_type', 'manufacturer', 'model', 'serial_no', 'purchased_on', 'status',
    'location', 'status_note', 'status_changed_at', 'version',
  ],
  asset_assignments: [
    'asset_id', 'emp_no', 'assigned_at', 'assigned_by', 'assign_note',
    'returned_at', 'returned_by', 'return_condition', 'return_note',
  ],
  asset_software: ['asset_id', 'software_name', 'version', 'installed_on'],
  licenses: ['id', 'product_name', 'vendor', 'license_type', 'quantity', 'expires_on', 'contract_no'],
  software_allowlist: ['id', 'pattern', 'match_type', 'license_id', 'note'],
  tickets: [
    'id', 'requester_emp_no', 'category', 'priority', 'title', 'symptom', 'status', 'assignee_emp_no',
    'created_at', 'updated_at', 'sla_due_at', 'sla_paused_minutes', 'hold_started_at', 'resolved_at',
    'cause', 'action_taken', 'verification', 'incident_url', 'version', 'asset_id',
  ],
  ticket_events: ['ticket_id', 'event_type', 'actor_emp_no', 'from_status', 'to_status', 'note', 'data', 'created_at'],
  faq_articles: ['id', 'source_ticket_id', 'category', 'title', 'question', 'answer', 'published_by', 'created_at'],
  // 4단계 가상 AD 디렉터리 (시드 객체의 키가 곧 열 이름)
  dir_groups: ['id', 'sam_account_name', 'cn', 'distinguished_name', 'group_scope', 'group_category', 'kind', 'description'],
  dir_users: [
    'id', 'sam_account_name', 'user_principal_name', 'distinguished_name', 'cn', 'ou_key', 'given_name', 'surname',
    'display_name', 'employee_id', 'department', 'title', 'description', 'kind', 'enabled', 'locked_out', 'lockout_time',
    'bad_pwd_count', 'pwd_last_set', 'last_logon', 'when_created', 'version',
  ],
  dir_memberships: ['group_id', 'user_id', 'added_at'],
  dir_events: ['event_id', 'event_name', 'occurred_at', 'target_user_id', 'target_sam', 'group_sam', 'actor_sam', 'operation_id', 'details'],
});

const EMPTY_HELPDESK = Object.freeze({ tickets: [], events: [], faqs: [] });
const EMPTY_DIRECTORY = Object.freeze({ groups: [], users: [], memberships: [], events: [] });
const pick = (columns) => (obj) => columns.map((c) => obj[c] ?? null);
const EMPTY_INVENTORY = Object.freeze({ assets: [], assignments: [], software: [], licenses: [], allowlist: [] });

/**
 * @param {{sites: any[], departments: any[], employees: any[]}} data generateSeedData() 결과
 * @param {{tickets: any[], events: any[], faqs: any[]}} helpdesk generateDemoTickets() 결과
 * @param {{assets, assignments, software, licenses, allowlist}} inventory generateDemoAssets() 결과
 * @returns {{sql: string, params: any[]}[]}
 */
export function buildResetStatements(data, helpdesk = EMPTY_HELPDESK, inventory = EMPTY_INVENTORY, directory = EMPTY_DIRECTORY) {
  const rows = {
    sites: data.sites.map((s) => [s.code, s.name, s.kind, s.sortOrder]),
    departments: data.departments.map((d) => [d.code, d.name, d.siteCode, d.sortOrder]),
    employees: data.employees.map((e) => [
      e.empNo, e.name, e.deptCode, e.jobTitle, e.isTeamLead ? 1 : 0, e.duty, e.hireDate, e.extension,
    ]),
    assets: inventory.assets.map((a) => [
      a.id, a.assetTag, a.assetType, a.manufacturer, a.model, a.serialNo, a.purchasedOn, a.status,
      a.location, a.statusNote, a.statusChangedAt, a.version,
    ]),
    asset_assignments: inventory.assignments.map((x) => [
      x.assetId, x.empNo, x.assignedAt, x.assignedBy, x.assignNote, x.returnedAt, x.returnedBy, x.returnCondition, x.returnNote,
    ]),
    asset_software: inventory.software.map((s) => [s.assetId, s.softwareName, s.version, s.installedOn]),
    licenses: inventory.licenses.map((l) => [l.id, l.productName, l.vendor, l.licenseType, l.quantity, l.expiresOn, l.contractNo]),
    software_allowlist: inventory.allowlist.map((w) => [w.id, w.pattern, w.matchType, w.licenseId, w.note]),
    tickets: helpdesk.tickets.map((t) => [
      t.id, t.requesterEmpNo, t.category, t.priority, t.title, t.symptom, t.status, t.assigneeEmpNo,
      t.createdAt, t.updatedAt, t.slaDueAt, t.slaPausedMinutes, t.holdStartedAt, t.resolvedAt,
      t.cause, t.actionTaken, t.verification, t.incidentUrl, t.version, t.assetId ?? null,
    ]),
    ticket_events: helpdesk.events.map((e) => [
      e.ticketId, e.eventType, e.actorEmpNo, e.fromStatus, e.toStatus, e.note, e.data, e.createdAt,
    ]),
    faq_articles: helpdesk.faqs.map((f) => [
      f.id, f.sourceTicketId, f.category, f.title, f.question, f.answer, f.publishedBy, f.createdAt,
    ]),
    dir_groups: directory.groups.map(pick(INSERT_COLUMNS.dir_groups)),
    dir_users: directory.users.map(pick(INSERT_COLUMNS.dir_users)),
    dir_memberships: directory.memberships.map(pick(INSERT_COLUMNS.dir_memberships)),
    dir_events: directory.events.map(pick(INSERT_COLUMNS.dir_events)),
  };

  const statements = DELETE_ORDER.map((table) => ({ sql: `DELETE FROM ${table}`, params: [] }));
  for (const [table, columns] of Object.entries(INSERT_COLUMNS)) {
    statements.push(...buildInsertStatements(table, columns, rows[table]));
  }
  return statements;
}
