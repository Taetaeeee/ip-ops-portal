import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleGroupsForDept, softwareProfileForDept, planSoftwareAssignment, planLicenseReclaim } from '../src/lib/lifecycle-plans.js';
import { generateDemoAssets } from '../src/lib/seed-assets.js';
import { generateSeedData } from '../src/lib/seed-data.js';
import { reconcileLicenses, matchAllowlist } from '../src/lib/license-reconcile.js';
import { GROUPS } from '../src/lib/ad-model.js';

const inv = generateDemoAssets({ employees: generateSeedData().employees, now: new Date('2026-11-17T04:30:00+09:00') });
const recon = () =>
  reconcileLicenses({ licenses: inv.licenses, allowlist: inv.allowlist, installs: inv.software, assets: inv.assets, today: inv.today });

test('부서 업무 그룹·표준 SW: 존재하는 그룹이고, 모든 SW 가 허용 목록 안', () => {
  const sams = GROUPS.map((g) => g.sam);
  for (const d of ['EXEC', 'MGMT', 'SALES', 'PURCH', 'RND', 'PROD', 'QC', 'MAINT', 'LOGI']) {
    for (const g of roleGroupsForDept(d)) assert.ok(sams.includes(g), `${d} ${g}`);
    for (const s of softwareProfileForDept(d)) assert.ok(matchAllowlist(s, inv.allowlist), `${d} ${s}`);
  }
  assert.ok(roleGroupsForDept('PURCH').includes('GG-ERP-Purchase'));
  assert.ok(!softwareProfileForDept('PROD').some((s) => s.startsWith('오피스')));
});

test('SW 배정: 영업팀 → 오피스·백신 라이선스 여유 있음 → 설치 목록', () => {
  const r = planSoftwareAssignment({
    profile: softwareProfileForDept('SALES'),
    installedOnDevice: ['데스크톱 운영체제 Pro 64비트', '웹 브라우저'],
    allowlist: inv.allowlist,
    licenses: recon().licenses,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, ['웹 브라우저']);
  assert.ok(r.installs.some((i) => i.licenseName === '오피스 제품군'));
});

test('SW 배정: 연구개발팀 → CAD 라이선스가 이미 초과 → 거부 (LICENSE_SHORTAGE)', () => {
  const r = planSoftwareAssignment({
    profile: softwareProfileForDept('RND'),
    installedOnDevice: [],
    allowlist: inv.allowlist,
    licenses: recon().licenses,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LICENSE_SHORTAGE');
  assert.deepEqual(r.shortages.map((s) => s.licenseName), ['CAD 설계 프로그램 LT (구독)']);
});

test('SW 배정: 남은 수량 0 이어도 같은 PC 에 이미 같은 라이선스 SW 가 있으면 추가 소모 없음', () => {
  const licenses = [{ id: 1, productName: '오피스', quantity: 1, installed: 1 }];
  const allowlist = [{ id: 1, pattern: '오피스', matchType: 'PREFIX', licenseId: 1 }];
  assert.equal(planSoftwareAssignment({ profile: ['오피스 2024'], installedOnDevice: ['오피스 2021'], allowlist, licenses }).ok, true);
  assert.equal(planSoftwareAssignment({ profile: ['오피스 2024'], installedOnDevice: [], allowlist, licenses }).ok, false);
});

test('라이선스 회수 대상: 유료 SW 만, 무료·기본 탑재는 제외', () => {
  const installs = [
    { id: 1, assetId: 9, assetTag: 'NB-0009', softwareName: '오피스 제품군 2021' },
    { id: 2, assetId: 9, assetTag: 'NB-0009', softwareName: '웹 브라우저' },
    { id: 3, assetId: 9, assetTag: 'NB-0009', softwareName: '엔드포인트 백신 v5' },
    { id: 4, assetId: 9, assetTag: 'NB-0009', softwareName: '데스크톱 운영체제 Pro 64비트' },
  ];
  const r = planLicenseReclaim(installs, inv.allowlist, inv.licenses);
  assert.deepEqual(r.map((x) => x.id), [1, 3]);
  assert.deepEqual(r.map((x) => x.licenseName), ['오피스 제품군', '엔드포인트 백신']);
});
