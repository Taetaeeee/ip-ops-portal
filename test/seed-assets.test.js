import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemoAssets } from '../src/lib/seed-assets.js';
import { generateSeedData } from '../src/lib/seed-data.js';
import { generateDemoTickets, TICKET_ASSET_REFS } from '../src/lib/seed-tickets.js';
import { reconcileLicenses } from '../src/lib/license-reconcile.js';
import { ASSIGNABLE_TYPES } from '../src/lib/asset-rules.js';
import { SLA_CONFIG } from '../src/lib/sla-config.js';

const employees = generateSeedData().employees;
// 매일 KST 04:30 초기화. 월말·연말 넘김도 확인
const NOWS = ['2026-11-17T04:30', '2026-12-31T04:30', '2027-02-27T04:30'].map((s) => new Date(`${s}:00+09:00`));

function reconcile(inv) {
  const holder = new Map(
    inv.assignments.filter((x) => !x.returnedAt).map((x) => [x.assetId, employees.find((e) => e.empNo === x.empNo).name]),
  );
  return reconcileLicenses({
    licenses: inv.licenses,
    allowlist: inv.allowlist,
    installs: inv.software,
    assets: inv.assets.map((a) => ({ ...a, holderName: holder.get(a.id) })),
    today: inv.today,
  });
}

for (const now of NOWS) {
  const inv = generateDemoAssets({ employees, now });

  test(`[${inv.today}] 완료 기준 데이터: 초과 1(CAD 설계)·만료 임박 1(PDF)·비인가 3종 4대`, () => {
    const r = reconcile(inv);
    assert.equal(r.summary.over, 1);
    assert.equal(r.licenses.find((l) => l.over).productName, 'CAD 설계 프로그램 LT (구독)');
    assert.equal(r.summary.expiring, 1);
    assert.equal(r.licenses.find((l) => l.expiry.state === 'EXPIRING').productName, 'PDF 편집기 Pro (구독)');
    assert.equal(r.summary.expired, 0);
    assert.equal(r.summary.unauthorizedSoftware, 3);
    assert.equal(r.summary.unauthorizedAssets, 4);
  });

  test(`[${inv.today}] 계획한 설치 수와 같다`, () => {
    const r = reconcile(inv);
    const installed = Object.fromEntries(r.licenses.map((l) => [l.id, [l.installed, l.quantity]]));
    assert.deepEqual(installed, {
      1: [33, 35], 2: [10, 12], 3: [4, 5], 4: [4, 3], 5: [44, 45], 6: [3, 5], 7: [2, 2], 8: [2, 3],
    });
  });
}

const inv = generateDemoAssets({ employees, now: NOWS[0] });

test('자산 60개: 개인 40·재고 3·수리 1·폐기 2·공용 14', () => {
  assert.equal(inv.assets.length, 60);
  const n = (s) => inv.assets.filter((a) => a.status === s).length;
  assert.equal(n('IN_STOCK'), 3);
  assert.equal(n('REPAIR'), 1);
  assert.equal(n('DISPOSED'), 2);
  assert.equal(inv.assets.filter((a) => a.location).length, 14);
});

test('자산 번호·시리얼 중복 없음, 번호 형식은 사번(DT-)과 다르다', () => {
  assert.equal(new Set(inv.assets.map((a) => a.assetTag)).size, 60);
  assert.equal(new Set(inv.assets.map((a) => a.serialNo)).size, 60);
  for (const a of inv.assets) assert.match(a.assetTag, /^(NB|PC|PR|NW|SV)-\d{4}$/);
});

test('배정: 직원마다 사용 중인 개인 PC 정확히 1대, 공용 장비는 배정 없음', () => {
  const open = inv.assignments.filter((x) => x.returnedAt === null);
  assert.equal(open.length, 40);
  assert.equal(new Set(open.map((x) => x.empNo)).size, 40);
  const byId = new Map(inv.assets.map((a) => [a.id, a]));
  for (const x of open) {
    const a = byId.get(x.assetId);
    assert.equal(a.status, 'IN_USE');
    assert.ok(ASSIGNABLE_TYPES.includes(a.assetType));
    assert.equal(a.location, null);
  }
  for (const a of inv.assets.filter((x) => x.location)) {
    assert.ok(!inv.assignments.some((x) => x.assetId === a.id), a.assetTag);
  }
});

test('반납 이력: 시간 순서가 맞고, 수리 자산은 고장 반납, 수리·폐기는 사유 있음', () => {
  const emp = new Map(employees.map((e) => [e.empNo, e]));
  for (const x of inv.assignments) {
    assert.ok(x.assignedAt.slice(0, 10) >= emp.get(x.empNo).hireDate, '입사 전 배정 없음');
    if (x.returnedAt) assert.ok(x.returnedAt > x.assignedAt);
  }
  // 같은 직원의 이전 PC 반납 → 새 PC 배정 순서
  for (const old of inv.assignments.filter((x) => x.returnedAt)) {
    const current = inv.assignments.find((x) => x.empNo === old.empNo && !x.returnedAt);
    assert.ok(old.returnedAt <= current.assignedAt, old.empNo);
  }
  const repair = inv.assets.find((a) => a.status === 'REPAIR');
  assert.equal(inv.assignments.find((x) => x.assetId === repair.id).returnCondition, 'REPAIR');
  for (const a of inv.assets.filter((x) => ['REPAIR', 'DISPOSED'].includes(x.status))) assert.ok(a.statusNote);
});

test('데모 티켓 12건이 관련 자산에 연결된다', () => {
  const demo = generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG, assets: inv });
  const linked = demo.tickets.filter((t) => t.assetId);
  assert.equal(linked.length, Object.keys(TICKET_ASSET_REFS).length);
  const label = demo.tickets.find((t) => t.title.includes('라벨 프린터'));
  assert.equal(inv.assets.find((a) => a.id === label.assetId).assetType, 'PRINTER');
  // 자산 없이 만들면 연결도 없다 (2단계 호환)
  assert.ok(generateDemoTickets({ now: NOWS[0], cfg: SLA_CONFIG }).tickets.every((t) => t.assetId === null));
});
