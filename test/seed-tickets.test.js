import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoTickets } from '../src/lib/seed-tickets.js';
import { generateSeedData, PERSONA_EMP_NO, ASSIGNEE_DUTIES } from '../src/lib/seed-data.js';
import { canTransition, isCategory, isPriority } from '../src/lib/ticket-rules.js';
import { slaState } from '../src/lib/sla.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';

// 초기화는 매일 KST 04:30. 여러 요일에서 확인한다 (화요일, 월요일, 토요일)
const NOWS = ['2026-11-17T04:30', '2026-11-16T04:30', '2026-11-14T04:30'].map((s) => new Date(`${s}:00+09:00`));
const employees = generateSeedData().employees;
const empNos = new Set(employees.map((e) => e.empNo));
const itStaff = new Set(employees.filter((e) => ASSIGNEE_DUTIES.includes(e.duty)).map((e) => e.empNo));

for (const now of NOWS) {
  const label = now.toISOString();
  const demo = generateDemoTickets({ now, cfg: SLA_CONFIG });

  test(`[${label}] 30건, 상태 분포 접수4·배정4·처리중7·보류3·완료12, FAQ 3`, () => {
    assert.equal(demo.tickets.length, 30);
    const count = (s) => demo.tickets.filter((t) => t.status === s).length;
    assert.deepEqual(
      [count('RECEIVED'), count('ASSIGNED'), count('IN_PROGRESS'), count('ON_HOLD'), count('RESOLVED')],
      [4, 4, 7, 3, 12],
    );
    assert.equal(demo.faqs.length, 3);
  });

  test(`[${label}] 모든 이력이 상태 전이 규칙을 통과하고, 최종 상태가 티켓과 같다`, () => {
    for (const t of demo.tickets) {
      const evs = demo.events.filter((e) => e.ticketId === t.id);
      assert.equal(evs[0].eventType, 'CREATED');
      let status = 'RECEIVED';
      let prevTime = '';
      for (const ev of evs) {
        assert.ok(ev.createdAt >= prevTime, `시간 순서 HD-${t.id}`);
        prevTime = ev.createdAt;
        if (ev.eventType === 'STATUS_CHANGED') {
          assert.equal(ev.fromStatus, status, `HD-${t.id} 이전 상태`);
          assert.ok(canTransition(ev.fromStatus, ev.toStatus), `HD-${t.id} ${ev.fromStatus}→${ev.toStatus}`);
          if (ev.toStatus === 'ON_HOLD') assert.ok(ev.note, '보류 사유 필수');
          status = ev.toStatus;
        }
      }
      assert.equal(status, t.status, `HD-${t.id} 최종 상태`);
    }
  });

  test(`[${label}] 모든 시각은 초기화 시각 이전, 접수 ≤ 이력 ≤ 갱신`, () => {
    for (const t of demo.tickets) {
      assert.ok(new Date(t.createdAt) <= now);
      assert.ok(new Date(t.updatedAt) <= now);
    }
    for (const e of demo.events) assert.ok(new Date(e.createdAt) <= now);
  });

  test(`[${label}] 참조와 필수값: 요청자·담당자 존재, 완료는 원인·조치·검증 결과 있음`, () => {
    for (const t of demo.tickets) {
      assert.ok(empNos.has(t.requesterEmpNo));
      assert.ok(!itStaff.has(t.requesterEmpNo), 'IT 담당자는 요청자가 아니다');
      assert.ok(isCategory(t.category) && isPriority(t.priority));
      if (t.status === 'RECEIVED') assert.equal(t.assigneeEmpNo, null);
      else assert.ok(itStaff.has(t.assigneeEmpNo));
      if (t.status === 'RESOLVED') assert.ok(t.cause && t.actionTaken && t.verification && t.resolvedAt);
      assert.equal(t.status === 'ON_HOLD', t.holdStartedAt !== null);
    }
  });

  test(`[${label}] SLA 표시용 분포: 초과·임박·기한 내 완료·기한 초과 완료가 모두 있다`, () => {
    const states = demo.tickets.map(
      (t) =>
        slaState(
          { status: t.status, priority: t.priority, dueAt: new Date(t.slaDueAt), resolvedAt: t.resolvedAt && new Date(t.resolvedAt) },
          now,
          SLA_CONFIG,
        ).state,
    );
    const n = (s) => states.filter((x) => x === s).length;
    assert.ok(n('OVERDUE') >= 3, `초과 ${n('OVERDUE')}`);
    assert.ok(n('IMMINENT') >= 3, `임박 ${n('IMMINENT')}`);
    assert.equal(n('PAUSED'), 3);
    assert.equal(n('BREACHED'), 2);
    assert.equal(n('MET'), 10);
  });
}

test('같은 시각이면 같은 결과', () => {
  assert.deepEqual(generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG }), generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG }));
});

test('데모 일반 직원(DT-0009)의 요청이 접수·처리 중·완료로 있다 ("내 요청 목록" 확인용)', () => {
  const mine = generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG }).tickets.filter((t) => t.requesterEmpNo === PERSONA_EMP_NO.employee);
  assert.deepEqual(mine.map((t) => t.status).sort(), ['IN_PROGRESS', 'RECEIVED', 'RESOLVED']);
});

test('FAQ에는 요청자 이름·사번이 없다', () => {
  const demo = generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG });
  const names = employees.map((e) => e.name);
  for (const f of demo.faqs) {
    const text = `${f.title} ${f.question} ${f.answer}`;
    assert.ok(!/DT-\d{4}/.test(text));
    for (const name of names) assert.ok(!text.includes(name), name);
  }
});
