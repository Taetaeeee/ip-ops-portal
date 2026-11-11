// 가상 AD 디렉터리 API (IT 담당자 전용)
// 규칙·스크립트 생성은 src/lib/ 의 순수 함수가 하고, 여기서는 읽기 → 계획 → 저장만 한다.

import { json, readJson } from './http.js';
import { requireSession } from './auth.js';
import { DOMAIN, OUS, USER_OU_KEYS, GROUPS, isOuKey, ouDn, ouPath } from './lib/ad-model.js';
import {
  OPERATIONS,
  EVENT_INFO,
  LOGON_STATUS,
  LOCKOUT_POLICY,
  isOperation,
  planOperation,
  availableOperations,
  evaluateLogon,
} from './lib/ad-operations.js';
import { buildDirectoryStatements } from './lib/dir-sql.js';
import { escapeLike } from './lib/sql-util.js';
import { randomTokenHex } from './lib/crypto-util.js';

function fail(status, code, message, errors) {
  return json({ error: { code, message, ...(errors ? { errors } : {}) } }, status);
}

const parseId = (v) => {
  const id = Number(v);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function kstStamp(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

const safeJson = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};

function rowToUser(r) {
  return {
    id: r.id,
    sam: r.sam_account_name,
    upn: r.user_principal_name,
    dn: r.distinguished_name,
    cn: r.cn,
    ouKey: r.ou_key,
    ouPath: ouPath(r.ou_key),
    givenName: r.given_name,
    surname: r.surname,
    displayName: r.display_name,
    employeeId: r.employee_id,
    department: r.department,
    title: r.title,
    description: r.description,
    kind: r.kind,
    enabled: r.enabled === 1,
    lockedOut: r.locked_out === 1,
    lockoutTime: r.lockout_time,
    badPwdCount: r.bad_pwd_count,
    pwdLastSet: r.pwd_last_set,
    lastLogon: r.last_logon,
    whenCreated: r.when_created,
    version: r.version,
  };
}

const eventDto = (e) => ({
  id: e.id,
  eventId: e.event_id,
  eventName: e.event_name,
  occurredAt: e.occurred_at,
  targetSam: e.target_sam,
  groupSam: e.group_sam,
  actorSam: e.actor_sam,
  operationId: e.operation_id,
  details: safeJson(e.details),
});

async function loadUser(env, id) {
  const r = await env.DB.prepare('SELECT * FROM dir_users WHERE id = ?').bind(id).first();
  return r ? rowToUser(r) : null;
}

async function loadMemberOf(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT g.sam_account_name, g.kind, g.description, g.distinguished_name, m.added_at
       FROM dir_memberships m JOIN dir_groups g ON g.id = m.group_id
      WHERE m.user_id = ? ORDER BY g.kind, g.sam_account_name`,
  )
    .bind(userId)
    .all();
  return results.map((g) => ({ sam: g.sam_account_name, kind: g.kind, description: g.description, dn: g.distinguished_name, addedAt: g.added_at }));
}

async function actorOf(env, session) {
  const r = await env.DB.prepare('SELECT sam_account_name FROM dir_users WHERE employee_id = ? AND kind = ?')
    .bind(session.employee.empNo, 'PERSON')
    .first();
  return r?.sam_account_name ?? 'unknown';
}

// ───────────────────────── 조회 ─────────────────────────

export async function handleDirMeta(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  return json({
    domain: DOMAIN,
    operations: OPERATIONS,
    events: EVENT_INFO,
    logonStatus: LOGON_STATUS,
    lockoutPolicy: LOCKOUT_POLICY,
    ous: OUS.map((o) => ({ ...o, dn: ouDn(o.key), path: ouPath(o.key) })),
    userOuKeys: USER_OU_KEYS,
    groups: GROUPS.map((g) => ({ sam: g.sam, kind: g.kind, description: g.description })),
  });
}

export async function handleDirTree(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const { results } = await env.DB.prepare(
    `SELECT ou_key, COUNT(*) AS total, SUM(enabled = 0) AS disabled, SUM(locked_out) AS locked
       FROM dir_users GROUP BY ou_key`,
  ).all();
  const own = Object.fromEntries(results.map((r) => [r.ou_key, { total: r.total, disabled: r.disabled, locked: r.locked }]));
  // 상위 OU 는 하위 합계
  const sum = (key) => {
    const base = { ...(own[key] ?? { total: 0, disabled: 0, locked: 0 }) };
    for (const child of OUS.filter((o) => o.parent === key)) {
      const c = sum(child.key);
      base.total += c.total;
      base.disabled += c.disabled;
      base.locked += c.locked;
    }
    return base;
  };
  const groupCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM dir_groups').first();
  return json({
    domain: DOMAIN,
    ous: OUS.map((o) => ({ key: o.key, name: o.name, parent: o.parent, kind: o.kind, leaf: o.leaf, dn: ouDn(o.key), counts: o.key === 'GROUPS' ? { groups: groupCount.n } : sum(o.key) })),
  });
}

const STATES = new Set(['DISABLED', 'LOCKED', 'ENABLED']);

export async function handleDirUsers(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const ou = params.get('ou') || null;
  const state = params.get('state') || null;
  const q = (params.get('q') || '').trim();
  if (ou && !isOuKey(ou)) return fail(400, 'INVALID_FILTER', '없는 OU 입니다');
  if (state && !STATES.has(state)) return fail(400, 'INVALID_FILTER', '잘못된 상태 필터입니다');
  if (q.length > 64) return fail(400, 'INVALID_FILTER', '검색어가 너무 깁니다');

  const where = [];
  const binds = [];
  if (ou) {
    // 상위 OU 를 고르면 하위 OU 사용자까지
    const keys = [];
    const walk = (k) => {
      keys.push(k);
      for (const c of OUS.filter((o) => o.parent === k)) walk(c.key);
    };
    walk(ou);
    where.push(`ou_key IN (${keys.map(() => '?').join(', ')})`);
    binds.push(...keys);
  }
  if (state === 'DISABLED') where.push('enabled = 0');
  if (state === 'ENABLED') where.push('enabled = 1');
  if (state === 'LOCKED') where.push('locked_out = 1');
  if (q) {
    const p = `%${escapeLike(q)}%`;
    where.push("(sam_account_name LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR user_principal_name LIKE ? ESCAPE '\\' OR employee_id LIKE ? ESCAPE '\\')");
    binds.push(p, p, p, p);
  }
  const sql = `SELECT * FROM dir_users${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ou_key, display_name LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ users: results.map(rowToUser), count: results.length });
}

async function userDetail(env, id) {
  const user = await loadUser(env, id);
  if (!user) return null;
  const [memberOf, events, ops] = await Promise.all([
    loadMemberOf(env, id),
    env.DB.prepare('SELECT * FROM dir_events WHERE target_user_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 50').bind(id).all(),
    env.DB.prepare('SELECT id, op_type, actor_sam, created_at FROM dir_operations WHERE target_user_id = ? ORDER BY id DESC LIMIT 10').bind(id).all(),
  ]);
  const memberSams = memberOf.map((g) => g.sam);
  return {
    user,
    memberOf,
    events: events.results.map(eventDto),
    operations: ops.results.map((o) => ({ id: o.id, type: o.op_type, label: OPERATIONS[o.op_type], actorSam: o.actor_sam, createdAt: o.created_at })),
    availableOperations: availableOperations(user, memberSams),
    addableGroups: GROUPS.map((g) => g.sam).filter((s) => !memberSams.includes(s)),
    moveTargets: USER_OU_KEYS.filter((k) => k !== user.ouKey).map((k) => ({ key: k, path: ouPath(k) })),
  };
}

export async function handleDirUser(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const id = parseId(params.id);
  const detail = id && (await userDetail(env, id));
  if (!detail) return fail(404, 'NOT_FOUND', '계정을 찾을 수 없습니다');
  return json(detail);
}

async function operationResult(env, opId) {
  const op = await env.DB.prepare('SELECT * FROM dir_operations WHERE id = ?').bind(opId).first();
  if (!op) return null;
  const { results } = await env.DB.prepare('SELECT * FROM dir_events WHERE operation_id = ? ORDER BY id').bind(opId).all();
  const user = op.target_user_id ? await loadUser(env, op.target_user_id) : null;
  return {
    operation: {
      id: op.id,
      type: op.op_type,
      label: OPERATIONS[op.op_type],
      targetUserId: op.target_user_id,
      targetSam: op.target_sam,
      actorSam: op.actor_sam,
      createdAt: op.created_at,
      executionStatus: op.execution_status,
      diff: safeJson(op.diff) ?? [],
      notes: safeJson(op.notes) ?? [],
      script: op.script,
    },
    events: results.map(eventDto),
    user, // 작업 후 현재 상태 (디렉터리 표시)
  };
}

export async function handleDirOperation(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const id = parseId(params.id);
  const result = id && (await operationResult(env, id));
  if (!result) return fail(404, 'NOT_FOUND', '작업 기록을 찾을 수 없습니다');
  return json(result);
}

// ───────────────────────── 작업 실행 ─────────────────────────

export async function handleDirOperationCreate(request, env) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = body.body ?? {};

  // 허용 목록 밖 작업은 DB 를 읽기 전에 바로 거부
  if (!isOperation(input.type)) {
    return fail(400, 'UNSUPPORTED_OPERATION', '허용 목록에 없는 작업입니다 (IT 담당자에게 위임된 범위 밖)');
  }

  let user = null;
  let memberOf = [];
  if (input.type !== 'CREATE_USER') {
    const id = parseId(input.userId);
    user = id && (await loadUser(env, id));
    if (!user) return fail(404, 'USER_NOT_FOUND', '대상 계정이 없습니다');
    memberOf = (await loadMemberOf(env, user.id)).map((g) => g.sam);
  }

  let takenSamsLower = new Set();
  if (input.type === 'CREATE_USER') {
    const { results } = await env.DB.prepare(
      'SELECT sam_account_name AS s FROM dir_users UNION ALL SELECT sam_account_name FROM dir_groups',
    ).all();
    takenSamsLower = new Set(results.map((r) => r.s.toLowerCase()));
  }
  // CN 충돌 검사용: 현재 DN 목록 (계정 수가 적어 한 번에 읽는다. 순수 함수에 동기 함수로 넘기기 위해)
  const existingDns = new Set(
    (await env.DB.prepare('SELECT distinguished_name AS dn FROM dir_users').all()).results.map((r) => r.dn.toLowerCase()),
  );

  const now = new Date();
  const plan = planOperation(input, {
    user,
    memberOf,
    groupSams: GROUPS.map((g) => g.sam),
    takenSamsLower,
    dnExists: (dn) => existingDns.has(dn.toLowerCase()),
    now,
    generatedAtKst: kstStamp(now),
  });
  if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.message, plan.errors);

  const actorSam = await actorOf(env, auth.session);
  const opToken = randomTokenHex(16);
  const stmts = buildDirectoryStatements(plan, {
    user: user ? { id: user.id, version: user.version } : null,
    writeToken: randomTokenHex(16),
    opToken,
    actorSam,
    actorEmpNo: auth.session.employee.empNo,
    nowIso: now.toISOString(),
    input,
  });

  let results;
  try {
    results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  } catch (err) {
    // 동시에 같은 계정명·DN 으로 생성한 경우 (DB UNIQUE 이중 안전장치)
    if (/UNIQUE/i.test(String(err?.message))) return fail(409, 'CONFLICT', '같은 계정명 또는 이름이 방금 생겼습니다. 다시 시도하세요');
    throw err;
  }
  if (results[0].meta.changes !== 1) {
    return fail(409, 'CONFLICT', '그 사이 다른 사람이 계정을 바꿨습니다. 새로고침 후 다시 시도하세요');
  }
  const op = await env.DB.prepare('SELECT id FROM dir_operations WHERE op_token = ?').bind(opToken).first();
  return json(await operationResult(env, op.id), 201);
}

// 로그인 시험 (사용자 행동 시뮬레이션)
export async function handleLogonTest(request, env, params) {
  const auth = await requireSession(env, request, { itStaffOnly: true });
  if (auth.response) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const id = parseId(params.id);
  const user = id && (await loadUser(env, id));
  if (!user) return fail(404, 'NOT_FOUND', '계정을 찾을 수 없습니다');
  if (typeof body.body?.passwordCorrect !== 'boolean') return fail(400, 'VALIDATION_FAILED', 'passwordCorrect(true/false)가 필요합니다');

  const now = new Date();
  const result = evaluateLogon(user, { passwordCorrect: body.body.passwordCorrect }, now);
  const stmts = buildDirectoryStatements(
    { type: 'LOGON_TEST', targetSam: user.sam, changes: result.changes, events: result.events },
    {
      user: { id: user.id, version: user.version },
      writeToken: randomTokenHex(16),
      record: false,
      actorSam: user.sam,
      eventActorSam: user.sam,
      nowIso: now.toISOString(),
    },
  );
  const results = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
  if (results[0].meta.changes !== 1) return fail(409, 'CONFLICT', '그 사이 계정이 바뀌었습니다. 다시 시도하세요');
  return json({ success: result.success, status: result.status ?? null, reason: result.reason, events: result.events, detail: await userDetail(env, id) });
}
