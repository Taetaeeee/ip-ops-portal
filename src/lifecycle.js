// 입·퇴사 처리 API (IT 담당자 전용)
//
// 체크리스트 항목 실행은 A-4(디렉터리)·A-3(자산) 실행 함수를 그대로 호출한다.
// 작업 1건과 "체크리스트 연결 + 항목 완료"를 같은 batch 에 넣어, 작업은 됐는데 체크리스트에 안 남는 일이 없게 한다.
// 여러 건이 필요한 항목(그룹 n개 제거, 장비 여러 대 반납)은 건마다 batch 를 나누고, 마지막 건에서 항목을 완료한다.
// 중간에 실패하면 다시 눌렀을 때 남은 것만 처리한다.

import { json, readJson } from './http.js';
import { requireSession } from './auth.js';
import {
  CASE_TYPES,
  ITEM_KINDS,
  NOTE_REQUIRED,
  buildChecklist,
  itemStates,
  executionProblem,
  employmentStatus,
  detectUnprocessedLeavers,
} from './lib/lifecycle-rules.js';
import { roleGroupsForDept, softwareProfileForDept, planSoftwareAssignment, planLicenseReclaim } from './lib/lifecycle-plans.js';
import { kstToday, reconcileLicenses } from './lib/license-reconcile.js';
import { planAssetAssign, planAssetReturn } from './lib/asset-rules.js';
import { textProblem } from './lib/ad-naming.js';
import { OPERATIONS } from './lib/ad-operations.js';
import { ouPath } from './lib/ad-model.js';
import { DEPARTMENTS } from './lib/seed-data.js';
import { executeDirectoryOperation, opGuard, findAccountsByEmployee, loadUser, loadMemberOf } from './directory.js';
import { executeAssetCommand, assetGuard, loadLicenseInputs, ASSIGNABLE_TYPES } from './assets.js';

const failR = (httpStatus, code, message, errors) => ({ ok: false, httpStatus, code, message, errors });
const respondFail = (r) => json({ error: { code: r.code, message: r.message, ...(r.errors ? { errors: r.errors } : {}) } }, r.httpStatus);
const parseId = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const safeJson = (t, d = null) => {
  try {
    return t ? JSON.parse(t) : d;
  } catch {
    return d;
  }
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const deptName = Object.fromEntries(DEPARTMENTS.map((d) => [d.code, d.name]));

// ───────────────────────── 읽기 ─────────────────────────

async function loadCase(env, caseId) {
  const c = await env.DB.prepare(
    `SELECT c.*, cb.name AS created_by_name
       FROM lifecycle_cases c JOIN employees cb ON cb.emp_no = c.created_by WHERE c.id = ?`,
  )
    .bind(caseId)
    .first();
  if (!c) return null;
  const { results } = await env.DB.prepare(
    `SELECT i.*, a.name AS assignee_name, d.name AS completed_by_name
       FROM checklist_items i
       LEFT JOIN employees a ON a.emp_no = i.assignee_emp_no
       LEFT JOIN employees d ON d.emp_no = i.completed_by
      WHERE i.case_id = ? ORDER BY i.seq`,
  )
    .bind(caseId)
    .all();
  const items = results.map((r) => ({
    id: r.id,
    seq: r.seq,
    itemKey: r.item_key,
    title: r.title,
    kind: r.kind,
    requires: safeJson(r.requires, []),
    status: r.status,
    assigneeEmpNo: r.assignee_emp_no,
    assigneeName: r.assignee_name,
    completedBy: r.completed_by,
    completedByName: r.completed_by_name,
    completedAt: r.completed_at,
    note: r.note,
    version: r.version,
  }));
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE emp_no = ?').bind(c.emp_no).first();
  return { c, items, emp };
}

async function caseDetail(env, caseId) {
  const loaded = await loadCase(env, caseId);
  if (!loaded) return null;
  const { c, items, emp } = loaded;
  const today = kstToday(new Date());
  const ids = items.map((i) => i.id);

  const links = ids.length
    ? (
        await env.DB.prepare(
          `SELECT l.*, o.op_type, o.target_sam, a.asset_tag, a.model AS asset_model
             FROM checklist_links l
             LEFT JOIN dir_operations o ON o.id = l.dir_operation_id
             LEFT JOIN assets a ON a.id = l.asset_id
            WHERE l.item_id IN (${ids.map(() => '?').join(', ')}) ORDER BY l.id`,
        )
          .bind(...ids)
          .all()
      ).results
    : [];
  const opIds = links.map((l) => l.dir_operation_id).filter(Boolean);
  const events = opIds.length
    ? (
        await env.DB.prepare(`SELECT operation_id, event_id FROM dir_events WHERE operation_id IN (${opIds.map(() => '?').join(', ')}) ORDER BY id`)
          .bind(...opIds)
          .all()
      ).results
    : [];

  const account = c.dir_user_id ? await loadUser(env, c.dir_user_id) : null;
  const memberOf = account ? await loadMemberOf(env, account.id) : [];
  const devices = (
    await env.DB.prepare(
      `SELECT a.id, a.asset_tag, a.asset_type, a.model, x.assigned_at
         FROM asset_assignments x JOIN assets a ON a.id = x.asset_id
        WHERE x.emp_no = ? AND x.returned_at IS NULL ORDER BY a.asset_tag`,
    )
      .bind(c.emp_no)
      .all()
  ).results;
  const stockDevices =
    c.case_type === 'ONBOARDING'
      ? (
          await env.DB.prepare(
            `SELECT id, asset_tag, asset_type, model FROM assets
              WHERE status = 'IN_STOCK' AND asset_type IN (${ASSIGNABLE_TYPES.map(() => '?').join(', ')}) ORDER BY asset_tag`,
          )
            .bind(...ASSIGNABLE_TYPES)
            .all()
        ).results
      : [];

  const states = itemStates(items);
  return {
    today,
    case: {
      id: c.id,
      caseType: c.case_type,
      label: CASE_TYPES[c.case_type],
      effectiveDate: c.effective_date,
      status: c.status,
      note: c.note,
      createdBy: c.created_by_name,
      createdAt: c.created_at,
      completedAt: c.completed_at,
    },
    employee: {
      empNo: emp.emp_no,
      name: emp.name,
      department: deptName[emp.dept_code],
      deptCode: emp.dept_code,
      jobTitle: emp.job_title,
      hireDate: emp.hire_date,
      resignDate: emp.resign_date,
      status: employmentStatus({ hireDate: emp.hire_date, resignDate: emp.resign_date }, today),
    },
    account: account
      ? { id: account.id, sam: account.sam, enabled: account.enabled, lockedOut: account.lockedOut, ouPath: account.ouPath, dn: account.dn, groups: memberOf.map((g) => g.sam) }
      : null,
    devices: devices.map((d) => ({ id: d.id, assetTag: d.asset_tag, assetType: d.asset_type, model: d.model, since: d.assigned_at })),
    stockDevices: stockDevices.map((d) => ({ id: d.id, assetTag: d.asset_tag, assetType: d.asset_type, model: d.model })),
    items: states.map((i) => ({
      id: i.id,
      seq: i.seq,
      itemKey: i.itemKey,
      title: i.title,
      kind: i.kind,
      kindLabel: ITEM_KINDS[i.kind],
      requires: i.requires,
      status: i.status,
      state: i.state,
      blockedBy: i.blockedBy,
      noteRequired: NOTE_REQUIRED[i.itemKey] ?? null,
      assignee: i.assigneeEmpNo ? { empNo: i.assigneeEmpNo, name: i.assigneeName } : null,
      completedBy: i.completedByName,
      completedAt: i.completedAt,
      note: i.note,
      links: links
        .filter((l) => l.item_id === i.id)
        .map((l) => ({
          type: l.link_type,
          createdAt: l.created_at,
          detail: safeJson(l.detail),
          operation: l.dir_operation_id
            ? {
                id: l.dir_operation_id,
                type: l.op_type,
                label: OPERATIONS[l.op_type],
                targetSam: l.target_sam,
                eventIds: events.filter((e) => e.operation_id === l.dir_operation_id).map((e) => e.event_id),
              }
            : null,
          asset: l.asset_id ? { id: l.asset_id, assetTag: l.asset_tag, model: l.asset_model } : null,
          assignmentId: l.assignment_id,
        })),
    })),
    progress: { done: items.filter((i) => i.status === 'DONE').length, total: items.length },
  };
}

// ───────────────────────── 목록 ─────────────────────────

export async function handleCaseList(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const today = kstToday(new Date());
  const [cases, emps, users] = await Promise.all([
    env.DB.prepare(
      `SELECT c.*, e.name, e.dept_code,
              (SELECT COUNT(*) FROM checklist_items i WHERE i.case_id = c.id) AS total,
              (SELECT COUNT(*) FROM checklist_items i WHERE i.case_id = c.id AND i.status = 'DONE') AS done
         FROM lifecycle_cases c JOIN employees e ON e.emp_no = c.emp_no
        ORDER BY c.status = 'OPEN' DESC, c.effective_date, c.id`,
    ).all(),
    env.DB.prepare('SELECT emp_no, name, dept_code, job_title, hire_date, resign_date FROM employees ORDER BY emp_no').all(),
    env.DB.prepare("SELECT id, sam_account_name, employee_id, enabled FROM dir_users WHERE kind = 'PERSON'").all(),
  ]);
  const openCases = cases.results.filter((c) => c.status === 'OPEN').map((c) => ({ id: c.id, empNo: c.emp_no, caseType: c.case_type }));
  const warnings = detectUnprocessedLeavers({
    employees: emps.results.map((e) => ({ empNo: e.emp_no, name: e.name, resignDate: e.resign_date })),
    dirUsers: users.results.map((u) => ({ id: u.id, sam: u.sam_account_name, employeeId: u.employee_id, enabled: u.enabled === 1 })),
    openCases,
    todayKst: today,
  }).map((w) => ({ ...w, department: deptName[emps.results.find((e) => e.emp_no === w.empNo)?.dept_code] }));

  const openOff = new Set(openCases.filter((c) => c.caseType === 'OFFBOARDING').map((c) => c.empNo));
  return json({
    today,
    warnings,
    cases: cases.results.map((c) => ({
      id: c.id,
      caseType: c.case_type,
      label: CASE_TYPES[c.case_type],
      empNo: c.emp_no,
      name: c.name,
      department: deptName[c.dept_code],
      effectiveDate: c.effective_date,
      status: c.status,
      progress: { done: c.done, total: c.total },
      createdAt: c.created_at,
      completedAt: c.completed_at,
    })),
    // 퇴사 케이스를 만들 수 있는 직원: 입사 예정이 아니고, 진행 중 퇴사 케이스가 없는 사람
    offboardCandidates: emps.results
      .filter((e) => employmentStatus({ hireDate: e.hire_date, resignDate: e.resign_date }, today) !== 'UPCOMING' && !openOff.has(e.emp_no))
      .map((e) => ({ empNo: e.emp_no, name: e.name, department: deptName[e.dept_code], jobTitle: e.job_title, resignDate: e.resign_date })),
    departments: DEPARTMENTS.map((d) => ({ code: d.code, name: d.name })),
  });
}

export async function handleCaseDetail(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const id = parseId(params.id);
  const d = id && (await caseDetail(env, id));
  if (!d) return respondFail(failR(404, 'NOT_FOUND', '케이스를 찾을 수 없습니다'));
  return json(d);
}

// ───────────────────────── 케이스 만들기 ─────────────────────────

function itemInsertStatements(items, caseKeySql, caseKeyParams) {
  return items.map((i) => ({
    sql:
      'INSERT INTO checklist_items (case_id, seq, item_key, title, kind, requires, status, assignee_emp_no) ' +
      `VALUES (${caseKeySql}, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    params: [...caseKeyParams, i.seq, i.itemKey, i.title, i.kind, JSON.stringify(i.requires), i.assigneeEmpNo],
  }));
}

export async function handleCaseCreate(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const b = body.body ?? {};
  const actor = auth.session.employee.empNo;
  const nowIso = new Date().toISOString();
  const today = kstToday(new Date());
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  const openCaseSql = "(SELECT id FROM lifecycle_cases WHERE emp_no = ? AND case_type = ? AND status = 'OPEN')";

  let stmts;
  let empNo;
  if (b.caseType === 'OFFBOARDING') {
    empNo = b.empNo;
    if (!DATE_RE.test(b.effectiveDate ?? '')) return respondFail(failR(400, 'VALIDATION_FAILED', '퇴사일(YYYY-MM-DD)을 입력해야 합니다'));
    const emp = typeof empNo === 'string' ? await env.DB.prepare('SELECT * FROM employees WHERE emp_no = ?').bind(empNo).first() : null;
    if (!emp) return respondFail(failR(400, 'INVALID_EMPLOYEE', '직원을 골라야 합니다'));
    if (employmentStatus({ hireDate: emp.hire_date, resignDate: null }, today) === 'UPCOMING') {
      return respondFail(failR(409, 'NOT_STARTED', '아직 입사 전인 직원입니다'));
    }
    if (b.effectiveDate < emp.hire_date) return respondFail(failR(400, 'VALIDATION_FAILED', '퇴사일이 입사일보다 빠릅니다'));
    const [account] = (await findAccountsByEmployee(env, empNo)).sort((x, y) => Number(y.enabled) - Number(x.enabled));
    const lead = await env.DB.prepare('SELECT emp_no FROM employees WHERE dept_code = ? AND is_team_lead = 1').bind(emp.dept_code).first();
    stmts = [
      { sql: 'UPDATE employees SET resign_date = ? WHERE emp_no = ?', params: [b.effectiveDate, empNo] },
      {
        sql:
          'INSERT INTO lifecycle_cases (case_type, emp_no, effective_date, status, dir_user_id, created_by, created_at, note) ' +
          "VALUES ('OFFBOARDING', ?, ?, 'OPEN', ?, ?, ?, ?)",
        params: [empNo, b.effectiveDate, account?.id ?? null, actor, nowIso, note],
      },
      ...itemInsertStatements(buildChecklist('OFFBOARDING', { itAssignee: actor, deptLead: lead?.emp_no }), openCaseSql, [empNo, 'OFFBOARDING']),
    ];
  } else if (b.caseType === 'ONBOARDING') {
    const errors = [];
    const nameProblem = textProblem(b.name, { label: '이름', max: 30 });
    if (nameProblem) errors.push({ field: 'name', message: nameProblem });
    if (!Object.hasOwn(deptName, b.deptCode ?? '')) errors.push({ field: 'deptCode', message: '부서를 골라야 합니다' });
    if (!DATE_RE.test(b.hireDate ?? '')) errors.push({ field: 'hireDate', message: '입사일(YYYY-MM-DD)을 입력해야 합니다' });
    const titleProblem = textProblem(b.jobTitle, { label: '직급', max: 20, required: false });
    if (titleProblem) errors.push({ field: 'jobTitle', message: titleProblem });
    if (errors.length) return respondFail(failR(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors));

    // 새 사번·내선: 지금 있는 것 다음 번호 (사번 DT-9xxx 는 옛 퇴사자 계정용이라 제외)
    const maxNo = await env.DB.prepare("SELECT MAX(emp_no) AS m FROM employees WHERE emp_no < 'DT-9'").first();
    empNo = `DT-${String(Number(maxNo.m.slice(3)) + 1).padStart(4, '0')}`;
    const site = DEPARTMENTS.find((d) => d.code === b.deptCode).siteCode;
    const siteDepts = DEPARTMENTS.filter((d) => d.siteCode === site).map((d) => d.code);
    const ext = await env.DB.prepare(
      `SELECT MAX(CAST(extension AS INTEGER)) AS m FROM employees WHERE dept_code IN (${siteDepts.map(() => '?').join(', ')})`,
    )
      .bind(...siteDepts)
      .first();
    stmts = [
      {
        sql: 'INSERT INTO employees (emp_no, name, dept_code, job_title, is_team_lead, duty, hire_date, extension) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)',
        params: [empNo, b.name.trim(), b.deptCode, b.jobTitle?.trim() || '사원', b.hireDate, String((ext.m ?? 0) + 1)],
      },
      {
        sql:
          'INSERT INTO lifecycle_cases (case_type, emp_no, effective_date, status, created_by, created_at, note) ' +
          "VALUES ('ONBOARDING', ?, ?, 'OPEN', ?, ?, ?)",
        params: [empNo, b.hireDate, actor, nowIso, note],
      },
      ...itemInsertStatements(buildChecklist('ONBOARDING', { itAssignee: actor }), openCaseSql, [empNo, 'ONBOARDING']),
    ];
  } else {
    return respondFail(failR(400, 'INVALID_CASE_TYPE', '케이스 종류는 입사 또는 퇴사입니다'));
  }

  try {
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return respondFail(failR(409, 'CASE_EXISTS', '이미 진행 중인 같은 종류의 케이스가 있습니다'));
    throw err;
  }
  const created = await env.DB.prepare(`SELECT id FROM lifecycle_cases WHERE emp_no = ? AND case_type = ? AND status = 'OPEN'`).bind(empNo, b.caseType).first();
  return json(await caseDetail(env, created.id), 201);
}

// ───────────────────────── 담당자 변경 ─────────────────────────

export async function handleItemAssignee(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const caseId = parseId(params.id);
  const itemId = parseId(params.itemId);
  const loaded = caseId && (await loadCase(env, caseId));
  const item = loaded?.items.find((i) => i.id === itemId);
  if (!item) return respondFail(failR(404, 'NOT_FOUND', '항목을 찾을 수 없습니다'));
  if (item.status === 'DONE') return respondFail(failR(409, 'ALREADY_DONE', '완료된 항목의 담당자는 바꿀 수 없습니다'));
  const assignee = body.body?.assigneeEmpNo;
  const emp = typeof assignee === 'string' ? await env.DB.prepare('SELECT emp_no FROM employees WHERE emp_no = ?').bind(assignee).first() : null;
  if (!emp) return respondFail(failR(400, 'INVALID_EMPLOYEE', '담당자를 골라야 합니다'));
  const r = await env.DB.prepare('UPDATE checklist_items SET assignee_emp_no = ?, version = version + 1 WHERE id = ? AND version = ?')
    .bind(assignee, item.id, item.version)
    .run();
  if (r.meta.changes !== 1) return respondFail(failR(409, 'CONFLICT', '그 사이 항목이 바뀌었습니다. 새로고침하세요'));
  return json(await caseDetail(env, caseId));
}

// ───────────────────────── 항목 실행 ─────────────────────────

/** 항목 완료 + (모든 항목이 끝났으면) 케이스 완료. guardSql 이 참일 때만 */
function completeStatements(item, caseId, actor, nowIso, note, guardSql = '1 = 1', guardParams = []) {
  return [
    {
      sql:
        "UPDATE checklist_items SET status = 'DONE', completed_by = ?, completed_at = ?, note = ?, version = version + 1 " +
        `WHERE id = ? AND version = ? AND status = 'PENDING' AND ${guardSql}`,
      params: [actor, nowIso, note, item.id, item.version, ...guardParams],
    },
    {
      sql:
        "UPDATE lifecycle_cases SET status = 'COMPLETED', completed_at = ? WHERE id = ? AND status = 'OPEN' " +
        "AND NOT EXISTS (SELECT 1 FROM checklist_items WHERE case_id = ? AND status <> 'DONE')",
      params: [nowIso, caseId, caseId],
    },
  ];
}

const pendingGuard = "EXISTS (SELECT 1 FROM checklist_items WHERE id = ? AND version = ? AND status = 'PENDING')";

function dirLinkStatement(item, tok, detail, nowIso) {
  return {
    sql:
      'INSERT INTO checklist_links (item_id, link_type, dir_operation_id, detail, created_at) ' +
      `SELECT ?, 'DIR_OPERATION', (SELECT id FROM dir_operations WHERE op_token = ?), ?, ? WHERE ${opGuard}`,
    params: [item.id, tok, detail ? JSON.stringify(detail) : null, nowIso, tok],
  };
}

/** 이미 원하는 상태일 때: 새 작업 없이 확인 완료 (가장 최근의 같은 종류 작업이 있으면 연결) */
async function completeAlready(env, ctx, item, note, { opType, userId } = {}) {
  const nowIso = new Date().toISOString();
  const stmts = [];
  if (opType && userId) {
    const last = await env.DB.prepare('SELECT id FROM dir_operations WHERE target_user_id = ? AND op_type = ? ORDER BY id DESC LIMIT 1')
      .bind(userId, opType)
      .first();
    if (last) {
      stmts.push({
        sql: `INSERT INTO checklist_links (item_id, link_type, dir_operation_id, detail, created_at) SELECT ?, 'DIR_OPERATION', ?, ?, ? WHERE ${pendingGuard}`,
        params: [item.id, last.id, JSON.stringify({ already: true }), nowIso, item.id, item.version],
      });
    }
  }
  stmts.push(...completeStatements(item, ctx.caseId, ctx.actor, nowIso, note));
  const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  if (results[stmts.length - 2].meta.changes !== 1) return failR(409, 'CONFLICT', '그 사이 항목이 바뀌었습니다. 새로고침하세요');
  return { ok: true, message: note };
}

/** 디렉터리 작업 1건 + 연결 (+ 마지막이면 항목 완료) */
async function runDirOp(env, ctx, item, input, { detail, complete, note, extra }) {
  const r = await executeDirectoryOperation(env, ctx.session, input, {
    extraStatements: (tok) => [
      dirLinkStatement(item, tok, detail, ctx.nowIso),
      ...(extra ? extra(tok) : []),
      ...(complete ? completeStatements(item, ctx.caseId, ctx.actor, ctx.nowIso, note, opGuard, [tok]) : []),
    ],
  });
  return r;
}

const EXECUTORS = {
  // ── 입사 ──
  async CREATE_ACCOUNT(env, ctx, item, body) {
    if (ctx.c.dir_user_id) return completeAlready(env, ctx, item, '이미 계정이 연결되어 있음');
    const existing = await findAccountsByEmployee(env, ctx.emp.emp_no);
    if (existing.length) {
      await env.DB.prepare('UPDATE lifecycle_cases SET dir_user_id = ? WHERE id = ?').bind(existing[0].id, ctx.caseId).run();
      return completeAlready(env, ctx, item, `사번이 같은 기존 계정(${existing[0].sam})을 연결`, { opType: 'CREATE_USER', userId: existing[0].id });
    }
    const input = {
      type: 'CREATE_USER',
      displayName: ctx.emp.name,
      ouKey: ctx.emp.dept_code,
      title: ctx.emp.job_title,
      employeeId: ctx.emp.emp_no,
      ...(body.surnameEn ? { surnameEn: body.surnameEn } : {}),
      ...(body.givenNameEn ? { givenNameEn: body.givenNameEn } : {}),
    };
    const r = await runDirOp(env, ctx, item, input, {
      complete: true,
      note: '계정 생성 (A-4)',
      extra: (tok) => [
        {
          sql: `UPDATE lifecycle_cases SET dir_user_id = (SELECT target_user_id FROM dir_operations WHERE op_token = ?) WHERE id = ? AND ${opGuard}`,
          params: [tok, ctx.caseId, tok],
        },
      ],
    });
    return r.ok ? { ok: true, message: `계정 ${r.result.operation.targetSam} 생성` } : r;
  },

  async ADD_ROLE_GROUPS(env, ctx, item) {
    const account = ctx.c.dir_user_id && (await loadUser(env, ctx.c.dir_user_id));
    if (!account) return failR(409, 'NO_ACCOUNT', '연결된 계정이 없습니다');
    const member = new Set((await loadMemberOf(env, account.id)).map((g) => g.sam));
    const targets = roleGroupsForDept(ctx.emp.dept_code).filter((g) => !member.has(g));
    if (!targets.length) return completeAlready(env, ctx, item, '추가할 업무 그룹 없음 (이미 반영됨)');
    for (const [i, group] of targets.entries()) {
      const last = i === targets.length - 1;
      const r = await runDirOp(env, ctx, item, { type: 'ADD_GROUP_MEMBER', userId: account.id, group }, {
        detail: { group },
        complete: last,
        note: `업무 그룹 추가: ${targets.join(', ')}`,
      });
      if (!r.ok) return { ...r, message: `${group} 추가 실패: ${r.message} (${i}개 처리됨. 다시 실행하면 남은 것만 처리)` };
    }
    return { ok: true, message: `업무 그룹 ${targets.length}개 추가` };
  },

  async ISSUE_DEVICE(env, ctx, item, body) {
    const assetId = parseId(body.assetId);
    if (!assetId) return failR(400, 'VALIDATION_FAILED', '지급할 장비(재고 PC)를 골라야 합니다');
    const empNo = ctx.emp.emp_no;
    const r = await executeAssetCommand(
      env,
      ctx.session,
      assetId,
      { empNo, note: `입사 지급 (입·퇴사 케이스 #${ctx.caseId})` },
      (asset, open, input) => planAssetAssign(asset, open, input, { isEmployee: (e) => e === empNo }),
      {
        extraStatements: (tok, x) => [
          {
            sql:
              'INSERT INTO checklist_links (item_id, link_type, asset_id, assignment_id, created_at) ' +
              `SELECT ?, 'ASSET_ASSIGN', ?, (SELECT id FROM asset_assignments WHERE asset_id = ? AND returned_at IS NULL), ? WHERE ${assetGuard}`,
            params: [item.id, x.assetId, x.assetId, x.nowIso, x.assetId, tok],
          },
          ...completeStatements(item, ctx.caseId, ctx.actor, x.nowIso, '장비 지급 (A-3)', assetGuard, [x.assetId, tok]),
        ],
      },
    );
    return r.ok ? { ok: true, message: `${r.assetTag} 지급` } : r;
  },

  async ASSIGN_SOFTWARE(env, ctx, item) {
    const device = (
      await env.DB.prepare(
        `SELECT a.id, a.asset_tag FROM asset_assignments x JOIN assets a ON a.id = x.asset_id
          WHERE x.emp_no = ? AND x.returned_at IS NULL AND a.asset_type IN ('LAPTOP', 'DESKTOP') ORDER BY x.assigned_at DESC LIMIT 1`,
      )
        .bind(ctx.emp.emp_no)
        .first()
    );
    if (!device) return failR(409, 'NO_DEVICE', '지급된 PC 가 없습니다');
    const inputs = await loadLicenseInputs(env);
    const recon = reconcileLicenses({ ...inputs, today: kstToday(new Date()) });
    const installed = inputs.installs.filter((s) => s.assetId === device.id).map((s) => s.softwareName);
    const plan = planSoftwareAssignment({
      profile: softwareProfileForDept(ctx.emp.dept_code),
      installedOnDevice: installed,
      allowlist: inputs.allowlist,
      licenses: recon.licenses,
    });
    if (!plan.ok) return failR(plan.httpStatus, plan.code, plan.message);
    const today = kstToday(new Date());
    const stmts = [];
    for (const s of plan.installs) {
      stmts.push(
        {
          sql: `INSERT INTO asset_software (asset_id, software_name, version, installed_on) SELECT ?, ?, NULL, ? WHERE ${pendingGuard}`,
          params: [device.id, s.softwareName, today, item.id, item.version],
        },
        {
          sql: `INSERT INTO checklist_links (item_id, link_type, asset_id, detail, created_at) SELECT ?, 'SOFTWARE_INSTALL', ?, ?, ? WHERE ${pendingGuard}`,
          params: [item.id, device.id, JSON.stringify({ softwareName: s.softwareName, licenseName: s.licenseName }), ctx.nowIso, item.id, item.version],
        },
      );
    }
    stmts.push(...completeStatements(item, ctx.caseId, ctx.actor, ctx.nowIso, `부서 표준 SW ${plan.installs.length}개 설치 기록 (${device.asset_tag})`));
    const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    if (results[stmts.length - 2].meta.changes !== 1) return failR(409, 'CONFLICT', '그 사이 항목이 바뀌었습니다. 새로고침하세요');
    return { ok: true, message: `${device.asset_tag} 에 ${plan.installs.length}개 설치 기록` };
  },

  // ── 퇴사 ──
  async DISABLE_ACCOUNT(env, ctx, item) {
    const account = ctx.c.dir_user_id && (await loadUser(env, ctx.c.dir_user_id));
    if (!account) return failR(409, 'NO_ACCOUNT', '연결된 계정이 없습니다');
    if (!account.enabled) return completeAlready(env, ctx, item, '이미 비활성 상태 확인', { opType: 'DISABLE_ACCOUNT', userId: account.id });
    const r = await runDirOp(env, ctx, item, { type: 'DISABLE_ACCOUNT', userId: account.id }, { complete: true, note: '계정 비활성화 (A-4)' });
    return r.ok ? { ok: true, message: `${account.sam} 비활성화` } : r;
  },

  async REMOVE_GROUPS(env, ctx, item) {
    const account = ctx.c.dir_user_id && (await loadUser(env, ctx.c.dir_user_id));
    if (!account) return failR(409, 'NO_ACCOUNT', '연결된 계정이 없습니다');
    const groups = (await loadMemberOf(env, account.id)).map((g) => g.sam);
    if (!groups.length) return completeAlready(env, ctx, item, '소속 그룹 없음 (이미 제거됨)');
    for (const [i, group] of groups.entries()) {
      const last = i === groups.length - 1;
      // 제거한 그룹은 연결 기록(detail)에 남는다 → 복직 때 참고
      const r = await runDirOp(env, ctx, item, { type: 'REMOVE_GROUP_MEMBER', userId: account.id, group }, {
        detail: { group },
        complete: last,
        note: `그룹 ${groups.length}개 제거 (복직 대비 기록): ${groups.join(', ')}`,
      });
      if (!r.ok) return { ...r, message: `${group} 제거 실패: ${r.message} (${i}개 처리됨. 다시 실행하면 남은 것만 처리)` };
    }
    return { ok: true, message: `그룹 ${groups.length}개 제거` };
  },

  async MOVE_TO_FORMER_OU(env, ctx, item) {
    const account = ctx.c.dir_user_id && (await loadUser(env, ctx.c.dir_user_id));
    if (!account) return failR(409, 'NO_ACCOUNT', '연결된 계정이 없습니다');
    if (account.ouKey === 'FORMER') return completeAlready(env, ctx, item, '이미 퇴사자 OU 에 있음', { opType: 'MOVE_OU', userId: account.id });
    const r = await runDirOp(env, ctx, item, { type: 'MOVE_OU', userId: account.id, ouKey: 'FORMER' }, {
      detail: { from: ouPath(account.ouKey), to: ouPath('FORMER') },
      complete: true,
      note: '퇴사자 OU 로 이동 (A-4)',
    });
    return r.ok ? { ok: true, message: `${account.sam} → 퇴사자 OU` } : r;
  },

  async RETURN_DEVICES(env, ctx, item) {
    const open = (
      await env.DB.prepare(
        `SELECT a.id, a.asset_tag FROM asset_assignments x JOIN assets a ON a.id = x.asset_id
          WHERE x.emp_no = ? AND x.returned_at IS NULL ORDER BY a.asset_tag`,
      )
        .bind(ctx.emp.emp_no)
        .all()
    ).results;
    if (!open.length) return completeAlready(env, ctx, item, '반납할 장비 없음');
    for (const [i, a] of open.entries()) {
      const last = i === open.length - 1;
      const r = await executeAssetCommand(
        env,
        ctx.session,
        a.id,
        { condition: 'IN_STOCK', note: `퇴사 반납 (입·퇴사 케이스 #${ctx.caseId})` },
        (asset, o, input) => planAssetReturn(asset, o, input),
        {
          extraStatements: (tok, x) => [
            {
              sql: `INSERT INTO checklist_links (item_id, link_type, asset_id, assignment_id, created_at) SELECT ?, 'ASSET_RETURN', ?, ?, ? WHERE ${assetGuard}`,
              params: [item.id, x.assetId, x.openAssignmentId, x.nowIso, x.assetId, tok],
            },
            ...(last ? completeStatements(item, ctx.caseId, ctx.actor, x.nowIso, `장비 ${open.length}대 반납 → 재고: ${open.map((d) => d.asset_tag).join(', ')}`, assetGuard, [x.assetId, tok]) : []),
          ],
        },
      );
      if (!r.ok) return { ...r, message: `${a.asset_tag} 반납 실패: ${r.message} (${i}대 처리됨. 다시 실행하면 남은 것만 처리)` };
    }
    return { ok: true, message: `장비 ${open.length}대 반납` };
  },

  async RECLAIM_LICENSES(env, ctx, item) {
    // 이 케이스에서 반납된 PC 들
    const returned = (
      await env.DB.prepare(
        `SELECT DISTINCT l.asset_id FROM checklist_links l JOIN checklist_items i ON i.id = l.item_id
          WHERE i.case_id = ? AND l.link_type = 'ASSET_RETURN'`,
      )
        .bind(ctx.caseId)
        .all()
    ).results.map((r) => r.asset_id);
    const inputs = await loadLicenseInputs(env);
    const today = kstToday(new Date());
    const before = reconcileLicenses({ ...inputs, today });
    const installs = returned.length
      ? (
          await env.DB.prepare(
            `SELECT s.id, s.asset_id, a.asset_tag, s.software_name FROM asset_software s JOIN assets a ON a.id = s.asset_id
              WHERE s.asset_id IN (${returned.map(() => '?').join(', ')}) ORDER BY a.asset_tag, s.software_name`,
          )
            .bind(...returned)
            .all()
        ).results.map((s) => ({ id: s.id, assetId: s.asset_id, assetTag: s.asset_tag, softwareName: s.software_name }))
      : [];
    const targets = planLicenseReclaim(installs, inputs.allowlist, inputs.licenses);
    if (!targets.length) return completeAlready(env, ctx, item, '회수할 유료 SW 없음');

    const stmts = [];
    for (const t of targets) {
      const lic = before.licenses.find((l) => l.id === t.licenseId);
      stmts.push(
        {
          // 설치 기록은 지워지므로 이름·라이선스를 연결 기록에 남긴다 (이력 보관)
          sql: `INSERT INTO checklist_links (item_id, link_type, asset_id, detail, created_at) SELECT ?, 'SOFTWARE_REMOVE', ?, ?, ? WHERE ${pendingGuard}`,
          params: [
            item.id, t.assetId,
            JSON.stringify({ softwareName: t.softwareName, licenseName: t.licenseName, installedBefore: lic?.installed ?? null }),
            ctx.nowIso, item.id, item.version,
          ],
        },
        { sql: `DELETE FROM asset_software WHERE id = ? AND ${pendingGuard}`, params: [t.id, item.id, item.version] },
      );
    }
    const names = [...new Set(targets.map((t) => t.licenseName))];
    stmts.push(...completeStatements(item, ctx.caseId, ctx.actor, ctx.nowIso, `유료 SW ${targets.length}건 회수: ${names.join(', ')}`));
    const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    if (results[stmts.length - 2].meta.changes !== 1) return failR(409, 'CONFLICT', '그 사이 항목이 바뀌었습니다. 새로고침하세요');
    return { ok: true, message: `${names.join(', ')} 회수` };
  },
};

// 수동 확인 항목 (메모 필수)
async function completeManual(env, ctx, item, body) {
  const problem = textProblem(body.note, { label: '메모', max: 500 });
  if (problem) return failR(400, 'NOTE_REQUIRED', NOTE_REQUIRED[item.itemKey] ?? problem);
  const stmts = completeStatements(item, ctx.caseId, ctx.actor, ctx.nowIso, body.note.trim());
  const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  if (results[0].meta.changes !== 1) return failR(409, 'CONFLICT', '그 사이 항목이 바뀌었습니다. 새로고침하세요');
  return { ok: true, message: `${item.title} 완료` };
}

export async function handleItemExecute(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const caseId = parseId(params.id);
  const itemId = parseId(params.itemId);
  const loaded = caseId && (await loadCase(env, caseId));
  if (!loaded) return respondFail(failR(404, 'NOT_FOUND', '케이스를 찾을 수 없습니다'));
  const item = loaded.items.find((i) => i.id === itemId);

  // 순서 규칙 (선행 미완료, 퇴사일 전 비활성화 등) — 순수 함수
  const problem = executionProblem(item, loaded.items, {
    caseStatus: loaded.c.status,
    caseType: loaded.c.case_type,
    effectiveDate: loaded.c.effective_date,
    todayKst: kstToday(new Date()),
  });
  if (problem) return respondFail({ ok: false, ...problem });

  const ctx = {
    session: auth.session,
    actor: auth.session.employee.empNo,
    caseId,
    c: loaded.c,
    emp: loaded.emp,
    nowIso: new Date().toISOString(),
  };
  const b = body.body ?? {};
  const r = item.kind === 'MANUAL' ? await completeManual(env, ctx, item, b) : await EXECUTORS[item.itemKey](env, ctx, item, b);
  if (!r.ok) return respondFail(r);
  return json({ message: r.message, detail: await caseDetail(env, caseId) });
}
