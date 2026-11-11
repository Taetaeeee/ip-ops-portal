// 가상 AD 작업 저장 SQL (순수 함수). 값은 전부 ? 바인딩.
//
// 작업 1건 = 한 batch:
//   ① 사용자 UPDATE(버전 조건) 또는 INSERT
//   ② 작업 기록(dir_operations) — 생성된 스크립트 포함
//   ③ 그룹 멤버십 추가·제거
//   ④ 보안 이벤트
// ②~④ 는 "①이 이 요청의 쓰기 토큰으로 반영됐을 때만" 들어간다 (2단계 티켓과 같은 낙관적 잠금 방식).

const UPDATABLE = new Set([
  'enabled', 'locked_out', 'lockout_time', 'bad_pwd_count', 'pwd_last_set', 'last_logon', 'ou_key', 'distinguished_name',
]);

const USER_INSERT_COLUMNS = [
  'sam_account_name', 'user_principal_name', 'distinguished_name', 'cn', 'ou_key', 'given_name', 'surname', 'display_name',
  'employee_id', 'department', 'title', 'description', 'kind', 'enabled', 'locked_out', 'lockout_time', 'bad_pwd_count',
  'pwd_last_set', 'last_logon', 'when_created',
];

/**
 * @param {object} plan planOperation() 의 성공 결과 또는 { changes, events } (로그인 시험)
 * @param {object} c
 *   user: { id, version } | null (계정 생성이면 null)
 *   writeToken, opToken: 무작위 문자열
 *   actorSam, actorEmpNo, nowIso
 *   input: 작업 입력 (작업 기록용) / record: false 면 작업 기록을 남기지 않음 (로그인 시험)
 *   eventActorSam: 이벤트의 작업자 (기본 actorSam)
 */
export function buildDirectoryStatements(plan, c) {
  if (typeof c.writeToken !== 'string' || c.writeToken.length < 16) throw new Error('writeToken 이 필요합니다');
  const statements = [];
  const creating = !c.user;

  // 대상 사용자 id 를 가리키는 SQL 조각 (생성이면 토큰으로 찾는다)
  const userIdSql = creating ? '(SELECT id FROM dir_users WHERE write_token = ?)' : '?';
  const userIdParam = creating ? c.writeToken : c.user.id;
  const guard = creating
    ? 'EXISTS (SELECT 1 FROM dir_users WHERE write_token = ?)'
    : 'EXISTS (SELECT 1 FROM dir_users WHERE id = ? AND write_token = ?)';
  const guardParams = creating ? [c.writeToken] : [c.user.id, c.writeToken];

  // ① 사용자
  if (creating) {
    const cols = [...USER_INSERT_COLUMNS, 'write_token'];
    statements.push({
      sql: `INSERT INTO dir_users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      params: [...USER_INSERT_COLUMNS.map((k) => plan.newUser[k] ?? null), c.writeToken],
    });
  } else {
    const sets = [];
    const params = [];
    for (const [col, value] of Object.entries(plan.changes ?? {})) {
      if (!UPDATABLE.has(col)) throw new Error(`변경할 수 없는 속성: ${col}`);
      sets.push(`${col} = ?`);
      params.push(value);
    }
    sets.push('version = version + 1', 'write_token = ?');
    params.push(c.writeToken, c.user.id, c.user.version);
    statements.push({ sql: `UPDATE dir_users SET ${sets.join(', ')} WHERE id = ? AND version = ?`, params });
  }

  // ② 작업 기록
  const record = c.record !== false;
  if (record) {
    statements.push({
      sql:
        'INSERT INTO dir_operations (op_token, op_type, target_user_id, target_sam, actor_sam, actor_emp_no, input, diff, notes, script, created_at) ' +
        `SELECT ?, ?, ${userIdSql}, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      params: [
        c.opToken, plan.type, userIdParam, plan.targetSam, c.actorSam, c.actorEmpNo ?? null,
        JSON.stringify(c.input ?? null), JSON.stringify(plan.diff ?? []), JSON.stringify(plan.notes ?? []),
        plan.script, c.nowIso, ...guardParams,
      ],
    });
  }

  // ③ 멤버십
  for (const group of plan.addGroups ?? []) {
    statements.push({
      sql: `INSERT INTO dir_memberships (group_id, user_id, added_at) SELECT g.id, ${userIdSql}, ? FROM dir_groups g WHERE g.sam_account_name = ? AND ${guard}`,
      params: [userIdParam, c.nowIso, group, ...guardParams],
    });
  }
  for (const group of plan.removeGroups ?? []) {
    statements.push({
      sql: `DELETE FROM dir_memberships WHERE user_id = ? AND group_id = (SELECT id FROM dir_groups WHERE sam_account_name = ?) AND ${guard}`,
      params: [userIdParam, group, ...guardParams],
    });
  }

  // ④ 이벤트
  const opIdSql = record ? '(SELECT id FROM dir_operations WHERE op_token = ?)' : 'NULL';
  for (const e of plan.events ?? []) {
    const actor = e.eventId === 4740 ? 'SYSTEM' : c.eventActorSam ?? c.actorSam;
    statements.push({
      sql:
        'INSERT INTO dir_events (event_id, event_name, occurred_at, target_user_id, target_sam, group_sam, actor_sam, operation_id, details) ' +
        `SELECT ?, ?, ?, ${userIdSql}, ?, ?, ?, ${opIdSql}, ? WHERE ${guard}`,
      params: [
        e.eventId, e.eventName, c.nowIso, userIdParam, plan.targetSam, e.groupSam ?? null, actor,
        ...(record ? [c.opToken] : []), e.details ? JSON.stringify(e.details) : null, ...guardParams,
      ],
    });
  }
  return statements;
}
