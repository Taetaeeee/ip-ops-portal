// SQL 도우미 (순수 함수)

/**
 * LIKE 검색어 이스케이프.
 * LIKE 에서 % 는 "아무 글자 여러 개", _ 는 "아무 글자 하나"라는 뜻이라,
 * 사용자가 "100%" 를 검색하면 의도와 다르게 동작한다. 앞에 \ 를 붙여 글자 그대로 찾게 한다.
 * SQL 에서는 반드시 `LIKE ? ESCAPE '\'` 와 함께 쓴다.
 */
export function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 여러 행을 넣는 INSERT 문을, 문장당 바인딩 매개변수 수 제한에 맞춰 나눈다.
 * (D1 은 문장당 매개변수 100개 제한이 있다고 알고 있다 - 공식 문서 확인 필요)
 * @param {string} table 내부 상수만 넘긴다 (사용자 입력 금지)
 * @param {string[]} columns 내부 상수만 넘긴다
 * @param {any[][]} rows 각 행은 columns 순서의 값 배열
 * @returns {{sql: string, params: any[]}[]}
 */
export function buildInsertStatements(table, columns, rows, maxParams = 100) {
  const rowsPerStatement = Math.floor(maxParams / columns.length);
  if (rowsPerStatement < 1) throw new RangeError('열이 너무 많습니다');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const statements = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    const chunk = rows.slice(i, i + rowsPerStatement);
    for (const row of chunk) {
      if (row.length !== columns.length) throw new RangeError(`${table}: 값 개수가 열 개수와 다릅니다`);
    }
    statements.push({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => rowPlaceholder).join(', ')}`,
      params: chunk.flat(),
    });
  }
  return statements;
}
