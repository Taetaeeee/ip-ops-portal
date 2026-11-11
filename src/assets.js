// IT 자산·라이선스 API (IT 담당자 전용)
// 규칙·대조는 src/lib/ 의 순수 함수가 하고, 여기서는 읽기 → 계획 → 저장만 한다.

import { json, readJson } from './http.js';
import { requireSession } from './auth.js';
import {
  ASSET_TYPES,
  ASSET_STATUSES,
  STATUS_TRANSITIONS,
  RETURN_CONDITIONS,
  ASSIGNABLE_TYPES,
  planAssetAssign,
  planAssetReturn,
  planAssetStatus,
} from './lib/asset-rules.js';
import { ASSET_SELECT, parseAssetFilters, buildAssetListQuery, buildAssetCommandStatements } from './lib/asset-query.js';
import { reconcileLicenses, matchAllowlist, kstToday, EXPIRY_STATES, EXPIRY_WARNING_DAYS } from './lib/license-reconcile.js';
import { ticketNo } from './lib/ticket-rules.js';
import { randomTokenHex } from './lib/crypto-util.js';

function fail(status, code, message, errors) {
  return json({ error: { code, message, ...(errors ? { errors } : {}) } }, status);
}

function assetDto(row) {
  return {
    id: row.id,
    assetTag: row.asset_tag,
    assetType: row.asset_type,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNo: row.serial_no,
    purchasedOn: row.purchased_on,
    status: row.status,
    location: row.location,
    statusNote: row.status_note,
    statusChangedAt: row.status_changed_at,
    holder: row.holder_emp_no
      ? { empNo: row.holder_emp_no, name: row.holder_name, department: row.holder_dept, since: row.holder_since }
      : null,
  };
}

const parseId = (params) => {
  const id = Number(params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function loadAssetRow(env, id) {
  return env.DB.prepare(`${ASSET_SELECT}\n   WHERE a.id = ?`).bind(id).first();
}

async function loadLicenseInputs(env) {
  const [lic, allow, installs, assets] = await Promise.all([
    env.DB.prepare('SELECT * FROM licenses ORDER BY id').all(),
    env.DB.prepare('SELECT * FROM software_allowlist ORDER BY id').all(),
    env.DB.prepare('SELECT asset_id, software_name, version FROM asset_software').all(),
    env.DB.prepare(ASSET_SELECT).all(),
  ]);
  return {
    licenses: lic.results.map((l) => ({
      id: l.id, productName: l.product_name, vendor: l.vendor, licenseType: l.license_type,
      quantity: l.quantity, expiresOn: l.expires_on, contractNo: l.contract_no,
    })),
    allowlist: allow.results.map((w) => ({ id: w.id, pattern: w.pattern, matchType: w.match_type, licenseId: w.license_id, note: w.note })),
    installs: installs.results.map((s) => ({ assetId: s.asset_id, softwareName: s.software_name, version: s.version })),
    assets: assets.results.map((a) => ({
      id: a.id, assetTag: a.asset_tag, status: a.status, holderName: a.holder_name ?? null, location: a.location,
    })),
  };
}

// ───────────────────────── 조회 ─────────────────────────

export async function handleAssetMeta(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const { results } = await env.DB.prepare(
    `SELECT e.emp_no, e.name, e.job_title, d.name AS dept
       FROM employees e JOIN departments d ON d.code = e.dept_code ORDER BY d.sort_order, e.emp_no`,
  ).all();
  return json({
    types: ASSET_TYPES,
    statuses: ASSET_STATUSES,
    statusTransitions: STATUS_TRANSITIONS,
    returnConditions: RETURN_CONDITIONS,
    assignableTypes: ASSIGNABLE_TYPES,
    expiryStates: EXPIRY_STATES,
    expiryWarningDays: EXPIRY_WARNING_DAYS,
    employees: results.map((e) => ({ empNo: e.emp_no, name: e.name, jobTitle: e.job_title, department: e.dept })),
  });
}

export async function handleAssetList(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const parsed = parseAssetFilters(new URL(request.url).searchParams);
  if (!parsed.ok) return fail(400, 'INVALID_FILTER', `잘못된 필터: ${parsed.errors.join(', ')}`);
  const { sql, params } = buildAssetListQuery(parsed.filters);
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ assets: results.map(assetDto), count: results.length });
}

async function assetDetail(env, id) {
  const row = await loadAssetRow(env, id);
  if (!row) return null;
  const [history, software, tickets, allow, lic] = await Promise.all([
    env.DB.prepare(
      `SELECT x.*, e.name AS emp_name, d.name AS emp_dept, b.name AS assigned_by_name, r.name AS returned_by_name
         FROM asset_assignments x
         JOIN employees e ON e.emp_no = x.emp_no
         JOIN departments d ON d.code = e.dept_code
         JOIN employees b ON b.emp_no = x.assigned_by
         LEFT JOIN employees r ON r.emp_no = x.returned_by
        WHERE x.asset_id = ?
        ORDER BY x.assigned_at DESC, x.id DESC`,
    ).bind(id).all(),
    env.DB.prepare('SELECT software_name, version, installed_on FROM asset_software WHERE asset_id = ? ORDER BY software_name').bind(id).all(),
    env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.created_at, r.name AS requester_name
         FROM tickets t JOIN employees r ON r.emp_no = t.requester_emp_no
        WHERE t.asset_id = ? ORDER BY t.id DESC`,
    ).bind(id).all(),
    env.DB.prepare('SELECT * FROM software_allowlist').all(),
    env.DB.prepare('SELECT id, product_name FROM licenses').all(),
  ]);
  const allowlist = allow.results.map((w) => ({ id: w.id, pattern: w.pattern, matchType: w.match_type, licenseId: w.license_id }));
  const licenseName = new Map(lic.results.map((l) => [l.id, l.product_name]));

  return {
    asset: assetDto(row),
    assignments: history.results.map((x) => ({
      id: x.id,
      employee: { empNo: x.emp_no, name: x.emp_name, department: x.emp_dept },
      assignedAt: x.assigned_at,
      assignedBy: x.assigned_by_name,
      assignNote: x.assign_note,
      returnedAt: x.returned_at,
      returnedBy: x.returned_by_name,
      returnCondition: x.return_condition,
      returnNote: x.return_note,
    })),
    software: software.results.map((s) => {
      const m = matchAllowlist(s.software_name, allowlist);
      return {
        name: s.software_name,
        version: s.version,
        installedOn: s.installed_on,
        // 라이선스 대상 / 허용(무료·기본) / 비인가
        classification: !m ? 'UNAUTHORIZED' : m.licenseId != null ? 'LICENSED' : 'ALLOWED',
        licenseName: m?.licenseId != null ? licenseName.get(m.licenseId) ?? null : null,
      };
    }),
    tickets: tickets.results.map((t) => ({
      id: t.id, ticketNo: ticketNo(t.id), title: t.title, status: t.status, priority: t.priority,
      createdAt: t.created_at, requesterName: t.requester_name,
    })),
    allowedStatusChanges: STATUS_TRANSITIONS[row.status],
  };
}

export async function handleAssetDetail(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const id = parseId(params);
  const detail = id && (await assetDetail(env, id));
  if (!detail) return fail(404, 'NOT_FOUND', '자산을 찾을 수 없습니다');
  return json(detail);
}

export async function handleLicenses(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const inputs = await loadLicenseInputs(env);
  return json(reconcileLicenses({ ...inputs, today: kstToday(new Date()) }));
}

// ───────────────────────── 작업 (배정·반납·상태) ─────────────────────────

async function runAssetCommand(request, env, params, makePlan) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const r = await executeAssetCommand(env, auth.session, parseId(params), body.body, makePlan);
  if (!r.ok) return fail(r.httpStatus, r.code, r.message, r.errors);
  return json(await assetDetail(env, r.assetId));
}

/**
 * 자산 작업 실행 (API 와 5단계 입·퇴사 체크리스트가 함께 쓴다)
 * @param {number} assetId
 * @param {object} input
 * @param {(asset, open, input) => plan} makePlan
 * @param {object} [options] extraStatements: (writeToken) => [{sql, params}] — assetGuard 조건과 함께 쓴다
 */
export async function executeAssetCommand(env, session, assetId, input, makePlan, { extraStatements } = {}) {
  const failR = (httpStatus, code, message, errors) => ({ ok: false, httpStatus, code, message, errors });
  const row = assetId && (await loadAssetRow(env, assetId));
  if (!row) return failR(404, 'NOT_FOUND', '자산을 찾을 수 없습니다');

  const asset = { id: row.id, assetType: row.asset_type, status: row.status, version: row.version };
  const open = row.open_assignment_id ? { id: row.open_assignment_id, empNo: row.holder_emp_no } : null;
  const plan = await makePlan(asset, open, input);
  if (!plan.ok) return failR(plan.httpStatus, plan.code, plan.message, plan.errors);

  const token = randomTokenHex(16);
  const nowIso = new Date().toISOString();
  const stmts = [
    ...buildAssetCommandStatements(asset, plan, session.employee.empNo, nowIso, token),
    ...(extraStatements ? extraStatements(token, { assetId: asset.id, nowIso, openAssignmentId: open?.id ?? null }) : []),
  ];
  let results;
  try {
    results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  } catch (err) {
    // 부분 고유 인덱스(한 자산에 열린 배정 1건)에 걸린 경우
    if (/UNIQUE/i.test(String(err?.message))) return failR(409, 'CONFLICT', '이미 다른 사용자에게 배정됐습니다');
    throw err;
  }
  if (results[0].meta.changes !== 1) {
    return failR(409, 'CONFLICT', '그 사이 다른 사람이 자산을 바꿨습니다. 새로고침 후 다시 시도하세요');
  }
  return { ok: true, assetId: asset.id, assetTag: row.asset_tag };
}

/** 같은 batch 의 추가 SQL 이 "자산 작업이 반영됐을 때만" 실행되게 하는 조건 (params: assetId, token) */
export const assetGuard = 'EXISTS (SELECT 1 FROM assets WHERE id = ? AND write_token = ?)';

export { loadLicenseInputs, ASSIGNABLE_TYPES };

export const handleAssetAssign = (request, env, params) =>
  runAssetCommand(request, env, params, async (asset, open, body) => {
    const empNo = typeof body?.empNo === 'string' ? body.empNo : '';
    const exists = empNo ? await env.DB.prepare('SELECT 1 FROM employees WHERE emp_no = ?').bind(empNo).first() : null;
    return planAssetAssign(asset, open, body, { isEmployee: (e) => e === empNo && !!exists });
  });

export const handleAssetReturn = (request, env, params) =>
  runAssetCommand(request, env, params, (asset, open, body) => planAssetReturn(asset, open, body));

export const handleAssetStatus = (request, env, params) =>
  runAssetCommand(request, env, params, (asset, open, body) => planAssetStatus(asset, body));
