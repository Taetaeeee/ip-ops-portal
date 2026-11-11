// 데모 초기화 계획을 만드는 순수 함수.
// 시드 데이터를 "지우기 → 넣기" 순서의 SQL 문 목록으로 바꾼다. 실행은 src/reset.js 가 한다.
//
// - 값은 전부 ? 자리표시자(바인딩 매개변수)로 넘긴다. SQL 문자열에 값을 이어 붙이지 않으므로
//   이름에 따옴표가 있어도 SQL 주입이 생기지 않는다.
// - 테이블 이름은 아래 상수에서만 오며, 사용자 입력이 들어가지 않는다.

// 지우는 순서: 다른 테이블이 참조하는 쪽(부모)을 나중에 지운다.
// sessions → employees 참조, employees → departments 참조, departments → sites 참조
export const DELETE_ORDER = Object.freeze(['sessions', 'employees', 'departments', 'sites']);

/**
 * @param {{sites: any[], departments: any[], employees: any[]}} data generateSeedData() 결과
 * @returns {{sql: string, params: any[]}[]}
 */
export function buildResetStatements(data) {
  const statements = [];

  for (const table of DELETE_ORDER) {
    statements.push({ sql: `DELETE FROM ${table}`, params: [] });
  }

  // 넣는 순서는 지우는 순서의 반대: 부모(sites) → 자식(employees)
  for (const s of data.sites) {
    statements.push({
      sql: 'INSERT INTO sites (code, name, kind, sort_order) VALUES (?, ?, ?, ?)',
      params: [s.code, s.name, s.kind, s.sortOrder],
    });
  }
  for (const d of data.departments) {
    statements.push({
      sql: 'INSERT INTO departments (code, name, site_code, sort_order) VALUES (?, ?, ?, ?)',
      params: [d.code, d.name, d.siteCode, d.sortOrder],
    });
  }
  for (const e of data.employees) {
    statements.push({
      sql:
        'INSERT INTO employees (emp_no, name, dept_code, job_title, is_team_lead, duty, hire_date, extension) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [e.empNo, e.name, e.deptCode, e.jobTitle, e.isTeamLead ? 1 : 0, e.duty, e.hireDate, e.extension],
    });
  }

  return statements;
}
