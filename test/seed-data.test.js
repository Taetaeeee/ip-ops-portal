import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSeedData,
  DEPARTMENTS,
  PERSONA_EMP_NO,
  IT_DUTY,
  COMPANY,
} from '../src/lib/seed-data.js';

const data = generateSeedData();

test('회사 이름은 가상 이름 도담테크산업', () => {
  assert.equal(data.company.name, COMPANY.name);
  assert.equal(data.company.name, '도담테크산업');
});

test('직원은 정확히 40명, 본사 20명·공장 20명', () => {
  assert.equal(data.employees.length, 40);
  const siteOf = Object.fromEntries(data.departments.map((d) => [d.code, d.siteCode]));
  const hq = data.employees.filter((e) => siteOf[e.deptCode] === 'HQ').length;
  const plant = data.employees.filter((e) => siteOf[e.deptCode] === 'PLANT1').length;
  assert.equal(hq, 20);
  assert.equal(plant, 20);
});

test('사번·이름·내선은 중복이 없다', () => {
  const unique = (key) => new Set(data.employees.map((e) => e[key])).size;
  assert.equal(unique('empNo'), 40);
  assert.equal(unique('name'), 40);
  assert.equal(unique('extension'), 40);
});

test('모든 직원은 존재하는 부서에, 모든 부서는 존재하는 사업장에 속한다', () => {
  const deptCodes = new Set(data.departments.map((d) => d.code));
  const siteCodes = new Set(data.sites.map((s) => s.code));
  for (const e of data.employees) assert.ok(deptCodes.has(e.deptCode), e.empNo);
  for (const d of data.departments) assert.ok(siteCodes.has(d.siteCode), d.code);
});

test('부서별 인원이 정의와 같다', () => {
  for (const dept of DEPARTMENTS) {
    const count = data.employees.filter((e) => e.deptCode === dept.code).length;
    assert.equal(count, dept.headcount, dept.code);
  }
});

test('임원실을 뺀 부서마다 팀장이 정확히 1명', () => {
  for (const dept of DEPARTMENTS) {
    const leads = data.employees.filter((e) => e.deptCode === dept.code && e.isTeamLead).length;
    assert.equal(leads, dept.fixedTitles ? 0 : 1, dept.code);
  }
});

test('입사일은 올바른 YYYY-MM-DD 날짜', () => {
  for (const e of data.employees) {
    assert.match(e.hireDate, /^\d{4}-\d{2}-\d{2}$/);
    const d = new Date(`${e.hireDate}T00:00:00Z`);
    assert.equal(d.toISOString().slice(0, 10), e.hireDate, e.empNo);
  }
});

test('같은 시드는 같은 결과, 다른 시드는 다른 결과', () => {
  assert.deepEqual(generateSeedData(), generateSeedData());
  assert.notDeepEqual(generateSeedData(1).employees, generateSeedData(2).employees);
});

test('페르소나 직원: IT 담당자는 경영지원팀 전산 담당, 일반 직원은 영업팀 팀원', () => {
  const it = data.employees.find((e) => e.empNo === PERSONA_EMP_NO.it_admin);
  const emp = data.employees.find((e) => e.empNo === PERSONA_EMP_NO.employee);
  assert.ok(it && emp);
  assert.equal(it.deptCode, 'MGMT');
  assert.equal(it.duty, IT_DUTY);
  assert.equal(it.isTeamLead, false);
  assert.equal(emp.deptCode, 'SALES');
  assert.equal(emp.isTeamLead, false);
  // 전산 담당은 한 명뿐
  assert.equal(data.employees.filter((e) => e.duty === IT_DUTY).length, 1);
});
