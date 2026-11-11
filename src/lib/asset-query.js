// 자산 SQL 만들기 (순수 함수). 값은 전부 ? 바인딩으로만 넘긴다.

import { isAssetType, isAssetStatus } from './asset-rules.js';
import { escapeLike } from './sql-util.js';

// 자산 + 현재 사용자(반납 안 된 배정)
export const ASSET_SELECT = `
  SELECT a.*,
         aa.id AS open_assignment_id, aa.emp_no AS holder_emp_no, aa.assigned_at AS holder_since,
         e.name AS holder_name, d.name AS holder_dept
    FROM assets a
    LEFT JOIN asset_assignments aa ON aa.asset_id = a.id AND aa.returned_at IS NULL
    LEFT JOIN employees e ON e.emp_no = aa.emp_no
    LEFT JOIN departments d ON d.code = e.dept_code`;

export function parseAssetFilters(params) {
  const get = (k) => {
    const v = params.get(k);
    return v === null || v.trim() === '' ? null : v.trim();
  };
  const filters = { type: get('type'), status: get('status'), holder: get('holder'), q: get('q') };
  const errors = [];
  if (filters.type && !isAssetType(filters.type)) errors.push('type');
  if (filters.status && filters.status !== 'ACTIVE' && !isAssetStatus(filters.status)) errors.push('status');
  if (filters.holder && !/^DT-\d{4}$/.test(filters.holder)) errors.push('holder');
  if (filters.q && filters.q.length > 100) errors.push('q');
  return { ok: errors.length === 0, errors, filters };
}

export function buildAssetListQuery(filters, limit = 500) {
  const where = [];
  const params = [];
  if (filters.type) {
    where.push('a.asset_type = ?');
    params.push(filters.type);
  }
  if (filters.status === 'ACTIVE') {
    where.push("a.status <> 'DISPOSED'");
  } else if (filters.status) {
    where.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.holder) {
    where.push('aa.emp_no = ?');
    params.push(filters.holder);
  }
  if (filters.q) {
    const p = `%${escapeLike(filters.q)}%`;
    const cols = ['a.asset_tag', 'a.manufacturer', 'a.model', 'a.serial_no', 'a.location', 'e.name'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...cols.map(() => p));
  }
  const sql =
    ASSET_SELECT +
    (where.length ? `\n   WHERE ${where.join('\n     AND ')}` : '') +
    `\n   ORDER BY a.asset_tag\n   LIMIT ${Number(limit) | 0}`;
  return { sql, params };
}

const UPDATABLE = new Set(['status', 'location', 'status_note']);

/**
 * 자산 작업 계획 → SQL. 2단계 티켓과 같은 낙관적 잠금:
 * UPDATE 가 버전 조건으로 0건이면 충돌. 배정 INSERT·반납 UPDATE 는 이 요청의 쓰기 토큰일 때만.
 */
export function buildAssetCommandStatements(asset, plan, actorEmpNo, nowIso, writeToken) {
  if (typeof writeToken !== 'string' || writeToken.length < 16) throw new Error('writeToken 이 필요합니다');
  const sets = [];
  const params = [];
  for (const [col, value] of Object.entries(plan.changes)) {
    if (!UPDATABLE.has(col)) throw new Error(`변경할 수 없는 열: ${col}`);
    sets.push(`${col} = ?`);
    params.push(value);
  }
  sets.push('status_changed_at = ?', 'version = version + 1', 'write_token = ?');
  params.push(nowIso, writeToken, asset.id, asset.version);

  const guard = 'EXISTS (SELECT 1 FROM assets WHERE id = ? AND write_token = ?)';
  const statements = [{ sql: `UPDATE assets SET ${sets.join(', ')} WHERE id = ? AND version = ?`, params }];

  if (plan.assignment) {
    statements.push({
      sql:
        'INSERT INTO asset_assignments (asset_id, emp_no, assigned_at, assigned_by, assign_note) ' +
        `SELECT ?, ?, ?, ?, ? WHERE ${guard}`,
      params: [asset.id, plan.assignment.empNo, nowIso, actorEmpNo, plan.assignment.note, asset.id, writeToken],
    });
  }
  if (plan.closeAssignment) {
    statements.push({
      sql:
        'UPDATE asset_assignments SET returned_at = ?, returned_by = ?, return_condition = ?, return_note = ? ' +
        `WHERE id = ? AND asset_id = ? AND returned_at IS NULL AND ${guard}`,
      params: [
        nowIso, actorEmpNo, plan.closeAssignment.condition, plan.closeAssignment.note,
        plan.closeAssignment.id, asset.id, asset.id, writeToken,
      ],
    });
  }
  return statements;
}
