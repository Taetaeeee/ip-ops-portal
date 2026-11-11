import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResetStatements, DELETE_ORDER } from '../src/lib/reset-plan.js';
import { generateSeedData } from '../src/lib/seed-data.js';

const data = generateSeedData();
const statements = buildResetStatements(data);

const firstIndex = (pred) => statements.findIndex(pred);
const lastIndex = (pred) => statements.findLastIndex(pred);
const isDelete = (s) => s.sql.startsWith('DELETE');
const isInsertInto = (table) => (s) => s.sql.startsWith(`INSERT INTO ${table} `);

test('모든 DELETE가 모든 INSERT보다 먼저 실행된다', () => {
  assert.ok(lastIndex(isDelete) < firstIndex((s) => s.sql.startsWith('INSERT')));
});

test('지우기는 자식 → 부모 순서 (참조 무결성)', () => {
  const deletes = statements.filter(isDelete).map((s) => s.sql.replace('DELETE FROM ', ''));
  assert.deepEqual(deletes, [...DELETE_ORDER]);
});

test('넣기는 부모 → 자식 순서: sites → departments → employees', () => {
  assert.ok(lastIndex(isInsertInto('sites')) < firstIndex(isInsertInto('departments')));
  assert.ok(lastIndex(isInsertInto('departments')) < firstIndex(isInsertInto('employees')));
});

test('행 수가 시드 데이터와 같다', () => {
  assert.equal(statements.filter(isInsertInto('sites')).length, data.sites.length);
  assert.equal(statements.filter(isInsertInto('departments')).length, data.departments.length);
  assert.equal(statements.filter(isInsertInto('employees')).length, data.employees.length);
});

test('자리표시자(?) 수와 매개변수 수가 같다', () => {
  for (const s of statements) {
    const placeholders = (s.sql.match(/\?/g) ?? []).length;
    assert.equal(placeholders, s.params.length, s.sql);
  }
});

test('값이 SQL 문자열에 직접 들어가지 않는다 (따옴표가 든 이름으로 확인)', () => {
  const evil = structuredClone(data);
  evil.employees[0].name = "홍'); DROP TABLE employees; --";
  const result = buildResetStatements(evil);
  for (const s of result) {
    assert.ok(!s.sql.includes('DROP'), s.sql);
    assert.ok(!s.sql.includes("'"), s.sql);
  }
  const inserted = result.find((s) => s.params.includes(evil.employees[0].name));
  assert.ok(inserted, '이름은 매개변수로 그대로 전달된다');
});
