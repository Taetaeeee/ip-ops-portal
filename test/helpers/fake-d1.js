// 테스트용 D1 대역: Node 내장 SQLite(node:sqlite)로 D1 API 일부를 흉내 낸다.
// 이 PC에서는 Windows 앱 제어 정책 때문에 wrangler dev(workerd)를 실행할 수 없어서,
// 실제 마이그레이션 SQL 로 만든 DB 에 Worker 코드를 직접 돌려 확인한다.
// 주의: D1 과 100% 같지는 않다 (예: 한도, 오류 메시지 형식). 배포 후 실제 환경 확인이 필요하다.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createFakeD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 은 외래 키를 기본으로 검사한다
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  const runOne = (sql, params) => {
    const r = db.prepare(sql).run(...params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    async first() {
      return db.prepare(this.sql).get(...this.params) ?? null;
    }
    async all() {
      return { success: true, results: db.prepare(this.sql).all(...this.params) };
    }
    async run() {
      return runOne(this.sql, this.params);
    }
  }

  const D1 = {
    prepare: (sql) => new Statement(sql),
    // batch: 하나의 트랜잭션. 하나라도 실패하면 전부 되돌린다.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => runOne(s.sql, s.params));
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { D1, raw: db };
}
