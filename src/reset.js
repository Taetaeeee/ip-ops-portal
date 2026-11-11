// 데모 초기화 실행부.
// 순수 함수(generateSeedData → buildResetStatements)가 만든 SQL 목록을 D1 batch로 한 번에 실행한다.
// batch 는 하나의 트랜잭션으로 실행돼, 중간에 실패하면 전부 되돌려진다고 알고 있다
// (공식 문서 확인 필요 - D1 "batch" 문서).

import { generateSeedData } from './lib/seed-data.js';
import { generateDemoTickets } from './lib/seed-tickets.js';
import { buildResetStatements } from './lib/reset-plan.js';
import { SLA_CONFIG } from './lib/sla-config.js';

/**
 * @param {'cron' | 'manual'} triggerType
 * @returns {Promise<{ok: boolean, statements: number, employees: number, message?: string}>}
 */
export async function runReset(env, triggerType, now = new Date()) {
  const startedAt = now.toISOString();
  const data = generateSeedData();
  // 데모 티켓은 초기화 시각 기준 상대 시각으로 만든다 (매일 같은 SLA 분포)
  const helpdesk = generateDemoTickets({ now, cfg: SLA_CONFIG });
  const statements = buildResetStatements(data, helpdesk);

  let result;
  try {
    await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    result = {
      ok: true,
      statements: statements.length,
      employees: data.employees.length,
      tickets: helpdesk.tickets.length,
    };
  } catch (err) {
    console.error('데모 초기화 실패', err);
    result = { ok: false, statements: 0, employees: 0, message: String(err?.message ?? err).slice(0, 500) };
  }

  // 기록 남기기가 실패해도 초기화 결과 자체는 돌려준다
  try {
    await env.DB.prepare(
      'INSERT INTO reset_runs (trigger_type, started_at, finished_at, status, statements, message) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(triggerType, startedAt, new Date().toISOString(), result.ok ? 'ok' : 'error', result.statements, result.message ?? null)
      .run();
  } catch (err) {
    console.error('초기화 기록 저장 실패', err);
  }

  return result;
}
