import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResetStatements, DELETE_ORDER, INSERT_COLUMNS } from '../src/lib/reset-plan.js';
import { generateSeedData } from '../src/lib/seed-data.js';
import { generateDemoTickets } from '../src/lib/seed-tickets.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';
import { generateDemoAssets } from '../src/lib/seed-assets.js';
import { generateDirectory } from '../src/lib/seed-directory.js';

const NOW = new Date('2026-11-17T04:30:00+09:00');
const data = generateSeedData();
const inventory = generateDemoAssets({ employees: data.employees, now: NOW });
const helpdesk = generateDemoTickets({ now: NOW, cfg: SLA_CONFIG, assets: inventory });
const directory = generateDirectory({ employees: data.employees, now: NOW });
const statements = buildResetStatements(data, helpdesk, inventory, directory);

const isDelete = (s) => s.sql.startsWith('DELETE');
const isInsertInto = (table) => (s) => s.sql.startsWith(`INSERT INTO ${table} (`);
const firstIndex = (pred) => statements.findIndex(pred);
const lastIndex = (pred) => statements.findLastIndex(pred);
const rowCount = (table) =>
  statements.filter(isInsertInto(table)).reduce((n, s) => n + s.params.length / INSERT_COLUMNS[table].length, 0);

test('모든 DELETE가 모든 INSERT보다 먼저 실행된다', () => {
  assert.ok(lastIndex(isDelete) < firstIndex((s) => s.sql.startsWith('INSERT')));
});

test('지우기는 자식 → 부모 순서 (참조 무결성)', () => {
  const deletes = statements.filter(isDelete).map((s) => s.sql.replace('DELETE FROM ', ''));
  assert.deepEqual(deletes, [...DELETE_ORDER]);
  const pos = (t) => deletes.indexOf(t);
  assert.ok(pos('ticket_events') < pos('tickets'));
  assert.ok(pos('faq_articles') < pos('tickets'));
  assert.ok(pos('tickets') < pos('employees'));
  assert.ok(pos('sessions') < pos('employees'));
  assert.ok(pos('tickets') < pos('assets'), '티켓이 자산을 참조');
  assert.ok(pos('asset_software') < pos('assets'));
  assert.ok(pos('asset_assignments') < pos('assets'));
  assert.ok(pos('software_allowlist') < pos('licenses'));
  assert.ok(pos('dir_events') < pos('dir_operations'));
  assert.ok(pos('dir_operations') < pos('dir_users'));
  assert.ok(pos('dir_memberships') < pos('dir_users'));
  assert.ok(pos('dir_memberships') < pos('dir_groups'));
});

test('넣기는 부모 → 자식 순서', () => {
  const order = [
    'sites', 'departments', 'employees', 'assets', 'asset_assignments', 'asset_software',
    'licenses', 'software_allowlist', 'tickets', 'ticket_events', 'faq_articles',
    'dir_groups', 'dir_users', 'dir_memberships', 'dir_events',
  ];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(lastIndex(isInsertInto(order[i])) < firstIndex(isInsertInto(order[i + 1])), `${order[i]} → ${order[i + 1]}`);
  }
});

test('행 수가 시드 데이터와 같다', () => {
  assert.equal(rowCount('sites'), data.sites.length);
  assert.equal(rowCount('departments'), data.departments.length);
  assert.equal(rowCount('employees'), 40);
  assert.equal(rowCount('tickets'), 30);
  assert.equal(rowCount('ticket_events'), helpdesk.events.length);
  assert.equal(rowCount('faq_articles'), 3);
  assert.equal(rowCount('assets'), 60);
  assert.equal(rowCount('licenses'), 8);
  assert.equal(rowCount('asset_assignments'), inventory.assignments.length);
  assert.equal(rowCount('asset_software'), inventory.software.length);
  assert.equal(rowCount('dir_users'), 45);
  assert.equal(rowCount('dir_groups'), 15);
  assert.equal(rowCount('dir_memberships'), directory.memberships.length);
  assert.equal(rowCount('dir_events'), directory.events.length);
});

test('문장마다 자리표시자(?) 수 = 매개변수 수, 매개변수는 100개 이하', () => {
  for (const s of statements) {
    assert.equal((s.sql.match(/\?/g) ?? []).length, s.params.length, s.sql.slice(0, 60));
    assert.ok(s.params.length <= 100, s.sql.slice(0, 60));
  }
});

test('여러 행을 묶어 문장 수가 적다 (D1 batch 부담 줄이기)', () => {
  assert.ok(statements.length < 110, `문장 수 ${statements.length}`);
});

test('값이 SQL 문자열에 직접 들어가지 않는다 (따옴표가 든 이름으로 확인)', () => {
  const evil = structuredClone(data);
  evil.employees[0].name = "홍'); DROP TABLE employees; --";
  const result = buildResetStatements(evil, helpdesk);
  for (const s of result) {
    assert.ok(!s.sql.includes('DROP'), s.sql.slice(0, 60));
    assert.ok(!s.sql.includes("'"), s.sql.slice(0, 60));
  }
  assert.ok(result.some((s) => s.params.includes(evil.employees[0].name)), '이름은 매개변수로 그대로 전달된다');
});

test('헬프데스크 데이터 없이도 동작한다 (1단계 호환)', () => {
  const only = buildResetStatements(data);
  assert.equal(only.filter((s) => s.sql.startsWith('INSERT INTO tickets')).length, 0);
});
