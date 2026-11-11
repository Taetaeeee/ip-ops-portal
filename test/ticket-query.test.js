import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListFilters, buildListQuery, buildCommandStatements } from '../src/lib/ticket-query.js';
import { escapeLike, buildInsertStatements } from '../src/lib/sql-util.js';

const it = { isItStaff: true, empNo: 'DT-0004' };
const staff = { isItStaff: false, empNo: 'DT-0009' };
const qs = (s) => new URLSearchParams(s);

test('직원은 어떤 필터를 보내도 자기 요청만 본다', () => {
  const { filters } = parseListFilters(qs('assignee=DT-0004&status=OPEN'), staff);
  assert.equal(filters.requesterEmpNo, 'DT-0009');
  assert.equal(filters.assignee, null);
  const { sql, params } = buildListQuery(filters);
  assert.ok(sql.includes('t.requester_emp_no = ?'));
  assert.equal(params[0], 'DT-0009');
});

test('목록에 없는 필터 값은 거부', () => {
  const r = parseListFilters(qs('status=DELETED&category=x&priority=1&sla=LATE&assignee=admin'), it);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.sort(), ['assignee', 'category', 'priority', 'sla', 'status']);
});

test('검색어는 바인딩으로만, % _ 는 이스케이프', () => {
  const { filters } = parseListFilters(qs("q=100%_'; DROP TABLE tickets;--"), it);
  const { sql, params } = buildListQuery(filters);
  assert.ok(!sql.includes('DROP'));
  assert.ok(sql.includes("LIKE ? ESCAPE '\\'"));
  assert.equal(params[0], "%100\\%\\_'; DROP TABLE tickets;--%");
  assert.equal((sql.match(/\?/g) ?? []).length, params.length);
});

test('escapeLike', () => {
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
});

test('미배정 필터와 미완료(OPEN) 필터', () => {
  const { filters } = parseListFilters(qs('assignee=NONE&status=OPEN'), it);
  const { sql, params } = buildListQuery(filters);
  assert.ok(sql.includes('t.assignee_emp_no IS NULL'));
  assert.ok(sql.includes("t.status <> 'RESOLVED'"));
  assert.equal(params.length, 0);
});

const TOKEN = '0123456789abcdef0123456789abcdef';

test('작업 SQL: 버전 조건으로 UPDATE, 이력은 이 요청의 쓰기 토큰일 때만 INSERT', () => {
  const plan = {
    changes: { status: 'IN_PROGRESS' },
    events: [{ eventType: 'STATUS_CHANGED', fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS', note: null, data: null }],
  };
  const stmts = buildCommandStatements({ id: 9, version: 4 }, plan, 'DT-0004', '2026-11-16T01:00:00.000Z', TOKEN);
  assert.ok(stmts[0].sql.endsWith('WHERE id = ? AND version = ?'));
  assert.ok(stmts[0].sql.includes('write_token = ?'));
  assert.deepEqual(stmts[0].params.slice(-3), [TOKEN, 9, 4]);
  assert.ok(stmts[1].sql.includes('WHERE EXISTS'));
  assert.deepEqual(stmts[1].params.slice(-2), [9, TOKEN]);
  for (const s of stmts) assert.equal((s.sql.match(/\?/g) ?? []).length, s.params.length, s.sql);
});

test('작업 SQL: 허용 목록 밖의 열은 바꿀 수 없고, 쓰기 토큰은 필수', () => {
  assert.throws(() =>
    buildCommandStatements({ id: 1, version: 1 }, { changes: { requester_emp_no: 'DT-0001' }, events: [] }, 'DT-0004', 'x', TOKEN),
  );
  assert.throws(() => buildCommandStatements({ id: 1, version: 1 }, { changes: {}, events: [] }, 'DT-0004', 'x'));
});

test('여러 행 INSERT: 문장당 매개변수 100개 이하로 나눈다', () => {
  const rows = Array.from({ length: 40 }, (_, i) => [i, `n${i}`, 'a', 'b', 'c', 'd', 'e', 'f']);
  const stmts = buildInsertStatements('employees', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows);
  assert.equal(stmts.length, 4); // 8열 → 문장당 12행 → 12,12,12,4
  for (const s of stmts) {
    assert.ok(s.params.length <= 100);
    assert.equal((s.sql.match(/\?/g) ?? []).length, s.params.length);
  }
  assert.equal(stmts.reduce((n, s) => n + s.params.length, 0), 40 * 8);
});
