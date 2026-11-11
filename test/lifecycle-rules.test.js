import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKLISTS,
  buildChecklist,
  itemStates,
  executionProblem,
  isCaseComplete,
  employmentStatus,
  detectUnprocessedLeavers,
} from '../src/lib/lifecycle-rules.js';

const off = () => buildChecklist('OFFBOARDING', { itAssignee: 'DT-0004', deptLead: 'DT-0014' });
const on = () => buildChecklist('ONBOARDING', { itAssignee: 'DT-0004' });
const done = (items, ...keys) => items.map((i) => (keys.includes(i.itemKey) ? { ...i, status: 'DONE' } : i));
const ctx = (o = {}) => ({ caseStatus: 'OPEN', caseType: 'OFFBOARDING', effectiveDate: '2026-11-17', todayKst: '2026-11-17', ...o });
const item = (items, key) => items.find((i) => i.itemKey === key);

test('체크리스트: 퇴사 6항목·입사 5항목, 순번, 담당자 기본값(백업 확인은 부서 팀장)', () => {
  const o = off();
  assert.deepEqual(o.map((i) => i.itemKey), CHECKLISTS.OFFBOARDING.map((t) => t.key));
  assert.deepEqual(o.map((i) => i.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(item(o, 'CONFIRM_BACKUP').assigneeEmpNo, 'DT-0014');
  assert.equal(item(o, 'DISABLE_ACCOUNT').assigneeEmpNo, 'DT-0004');
  assert.equal(on().length, 5);
  assert.throws(() => buildChecklist('TRANSFER', { itAssignee: 'x' }));
});

test('순서 규칙: 처음에는 선행이 없는 항목만 실행 가능 (퇴사: 비활성화·백업 확인)', () => {
  const s = itemStates(off());
  assert.deepEqual(s.filter((i) => i.state === 'READY').map((i) => i.itemKey), ['DISABLE_ACCOUNT', 'CONFIRM_BACKUP']);
  assert.deepEqual(item(s, 'MOVE_TO_FORMER_OU').blockedBy, ['그룹 제거']);
});

test('순서 규칙: 앞 항목 완료 전 실행 불가 (서버 거부 사유)', () => {
  const o = off();
  const p = executionProblem(item(o, 'REMOVE_GROUPS'), o, ctx());
  assert.equal(p.code, 'BLOCKED');
  assert.match(p.message, /계정 비활성화/);
  assert.equal(executionProblem(item(o, 'RETURN_DEVICES'), o, ctx()).code, 'BLOCKED'); // 백업 확인 전 반납 불가
  assert.equal(executionProblem(item(o, 'RECLAIM_LICENSES'), o, ctx()).code, 'BLOCKED');
  // 앞 항목을 끝내면 풀린다
  const o2 = done(o, 'DISABLE_ACCOUNT');
  assert.equal(executionProblem(item(o2, 'REMOVE_GROUPS'), o2, ctx()), null);
  assert.equal(executionProblem(item(o2, 'MOVE_TO_FORMER_OU'), o2, ctx()).code, 'BLOCKED');
});

test('독립 항목은 병렬: 계정 작업을 안 해도 백업 확인 → 장비 반납은 가능', () => {
  const o = done(off(), 'CONFIRM_BACKUP');
  assert.equal(executionProblem(item(o, 'RETURN_DEVICES'), o, ctx()), null);
});

test('입사: 여러 선행(그룹 추가 + SW 배정)이 모두 끝나야 사용자 안내', () => {
  let o = on();
  const c = ctx({ caseType: 'ONBOARDING' });
  assert.equal(executionProblem(item(o, 'USER_GUIDE'), o, c).code, 'BLOCKED');
  o = done(o, 'CREATE_ACCOUNT', 'ADD_ROLE_GROUPS');
  assert.match(executionProblem(item(o, 'USER_GUIDE'), o, c).message, /소프트웨어 배정/);
  o = done(o, 'ISSUE_DEVICE', 'ASSIGN_SOFTWARE');
  assert.equal(executionProblem(item(o, 'USER_GUIDE'), o, c), null);
});

test('퇴사일 전에는 비활성화 불가, 당일부터 가능 / 완료 항목·완료 케이스는 거부', () => {
  const o = off();
  assert.equal(executionProblem(item(o, 'DISABLE_ACCOUNT'), o, ctx({ todayKst: '2026-11-16' })).code, 'TOO_EARLY');
  assert.equal(executionProblem(item(o, 'DISABLE_ACCOUNT'), o, ctx({ todayKst: '2026-11-17' })), null);
  assert.equal(executionProblem(item(o, 'DISABLE_ACCOUNT'), o, ctx({ todayKst: '2026-11-20' })), null);
  const d = done(o, 'DISABLE_ACCOUNT');
  assert.equal(executionProblem(item(d, 'DISABLE_ACCOUNT'), d, ctx()).code, 'ALREADY_DONE');
  assert.equal(executionProblem(item(o, 'CONFIRM_BACKUP'), o, ctx({ caseStatus: 'COMPLETED' })).code, 'CASE_CLOSED');
});

test('케이스 완료 판정', () => {
  assert.equal(isCaseComplete(off()), false);
  assert.equal(isCaseComplete(done(off(), ...CHECKLISTS.OFFBOARDING.map((t) => t.key))), true);
  assert.equal(isCaseComplete([]), false);
});

test('재직 상태: 입사 예정 / 재직 / 퇴사일 당일 / 퇴사', () => {
  const t = '2026-11-17';
  assert.equal(employmentStatus({ hireDate: '2026-11-24' }, t), 'UPCOMING');
  assert.equal(employmentStatus({ hireDate: '2020-01-01' }, t), 'ACTIVE');
  assert.equal(employmentStatus({ hireDate: '2020-01-01', resignDate: '2026-11-17' }, t), 'LAST_DAY');
  assert.equal(employmentStatus({ hireDate: '2020-01-01', resignDate: '2026-11-16' }, t), 'RESIGNED');
  assert.equal(employmentStatus({ hireDate: '2020-01-01', resignDate: '2026-12-31' }, t), 'ACTIVE');
});

test('미처리 퇴사자: 퇴사일 다음 날부터, 활성 계정만, 계정 여러 개면 모두, 진행 중 케이스 표시', () => {
  const today = '2026-11-17';
  const employees = [
    { empNo: 'DT-0001', name: '당일', resignDate: '2026-11-17' }, // 당일 = 근무일 → 경고 없음
    { empNo: 'DT-0002', name: '어제', resignDate: '2026-11-16' }, // 경고
    { empNo: 'DT-0003', name: '처리됨', resignDate: '2026-11-01' }, // 비활성 → 경고 없음
    { empNo: 'DT-0004', name: '계정없음', resignDate: '2026-11-01' }, // 계정 없음 → 경고 없음
    { empNo: 'DT-0005', name: '재직', resignDate: null },
    { empNo: 'DT-0006', name: '두계정', resignDate: '2026-11-10' }, // 활성 계정 2개
  ];
  const dirUsers = [
    { id: 1, sam: 'a', employeeId: 'DT-0001', enabled: true },
    { id: 2, sam: 'b', employeeId: 'DT-0002', enabled: true },
    { id: 3, sam: 'c', employeeId: 'DT-0003', enabled: false },
    { id: 5, sam: 'e', employeeId: 'DT-0005', enabled: true },
    { id: 6, sam: 'f', employeeId: 'DT-0006', enabled: true },
    { id: 7, sam: 'f-admin', employeeId: 'DT-0006', enabled: true },
  ];
  const r = detectUnprocessedLeavers({ employees, dirUsers, openCases: [{ id: 9, empNo: 'DT-0002', caseType: 'OFFBOARDING' }], todayKst: today });
  assert.deepEqual(r.map((x) => x.empNo), ['DT-0006', 'DT-0002']); // 오래된 순
  assert.equal(r[0].daysOverdue, 7);
  assert.deepEqual(r[0].accounts.map((a) => a.sam), ['f', 'f-admin']);
  assert.equal(r[0].caseId, null);
  assert.equal(r[1].daysOverdue, 1);
  assert.equal(r[1].caseId, 9);
});
