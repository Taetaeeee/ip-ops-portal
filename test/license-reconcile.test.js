import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSoftwareName,
  matchAllowlist,
  daysUntil,
  addDays,
  kstToday,
  expiryState,
  reconcileLicenses,
} from '../src/lib/license-reconcile.js';

const TODAY = '2026-11-12';

const allowlist = [
  { id: 1, pattern: 'CAD 설계 프로그램', matchType: 'PREFIX', licenseId: 10 },
  { id: 2, pattern: 'CAD', matchType: 'PREFIX', licenseId: 11 }, // 더 짧은 앞부분 (뷰어 등)
  { id: 3, pattern: '압축 프로그램', matchType: 'EXACT', licenseId: null }, // 무료 허용, 정확히 일치만
  { id: 4, pattern: '오피스 제품군', matchType: 'PREFIX', licenseId: 12 },
];

const licenses = [
  { id: 10, productName: 'CAD 설계', quantity: 2, expiresOn: addDays(TODAY, 200) },
  { id: 11, productName: 'CAD 뷰어', quantity: 5, expiresOn: addDays(TODAY, 30) },
  { id: 12, productName: '오피스', quantity: 3, expiresOn: null },
];

const assets = [
  { id: 1, assetTag: 'NB-0001', status: 'IN_USE', holderName: '가' },
  { id: 2, assetTag: 'NB-0002', status: 'IN_USE', holderName: '나' },
  { id: 3, assetTag: 'NB-0003', status: 'IN_STOCK' },
  { id: 4, assetTag: 'NB-0004', status: 'REPAIR' },
  { id: 5, assetTag: 'NB-0005', status: 'DISPOSED' },
];

test('이름 정리: 대소문자·앞뒤 공백·연속 공백', () => {
  assert.equal(normalizeSoftwareName('  Office   Suite  2024 '), 'office suite 2024');
  assert.equal(normalizeSoftwareName(null), '');
});

test('허용 목록 매칭: 정확히 일치 우선, 앞부분은 가장 긴 것, EXACT 는 앞부분으로 안 맞음', () => {
  assert.equal(matchAllowlist('CAD 설계 프로그램 LT 2025', allowlist).id, 1);
  assert.equal(matchAllowlist('cad 뷰어 plus', allowlist).id, 2);
  assert.equal(matchAllowlist(' 압축  프로그램 ', allowlist).id, 3);
  assert.equal(matchAllowlist('압축 프로그램 Pro', allowlist), null);
  assert.equal(matchAllowlist('게임 런처', allowlist), null);
  assert.equal(matchAllowlist('', allowlist), null);
});

test('남은 날 수와 날짜 계산 (월·연 넘김)', () => {
  assert.equal(daysUntil('2026-11-12', TODAY), 0);
  assert.equal(daysUntil('2026-12-12', TODAY), 30);
  assert.equal(daysUntil('2026-11-11', TODAY), -1);
  assert.equal(addDays('2026-12-25', 10), '2027-01-04');
  assert.equal(kstToday(new Date('2026-11-11T15:00:00Z')), '2026-11-12'); // UTC 15시 = KST 다음 날 0시
  assert.equal(kstToday(new Date('2026-11-11T14:59:00Z')), '2026-11-11');
});

test('만료 판정 경계: 30일 남음은 임박, 31일은 정상, 0일은 임박, -1일은 만료, 없음은 영구', () => {
  assert.deepEqual(expiryState(addDays(TODAY, 30), TODAY), { state: 'EXPIRING', daysLeft: 30 });
  assert.deepEqual(expiryState(addDays(TODAY, 31), TODAY), { state: 'OK', daysLeft: 31 });
  assert.deepEqual(expiryState(TODAY, TODAY), { state: 'EXPIRING', daysLeft: 0 });
  assert.deepEqual(expiryState(addDays(TODAY, -1), TODAY), { state: 'EXPIRED', daysLeft: -1 });
  assert.deepEqual(expiryState(null, TODAY), { state: 'PERPETUAL', daysLeft: null });
  assert.equal(expiryState('언젠가', TODAY).state, 'EXPIRED');
});

function run(installs) {
  return reconcileLicenses({ licenses, allowlist, installs, assets, today: TODAY });
}
const lic = (r, id) => r.licenses.find((l) => l.id === id);

test('초과 경계: 설치 = 보유는 정상, 보유 + 1 은 초과', () => {
  const equal = run([
    { assetId: 1, softwareName: 'CAD 설계 프로그램 LT' },
    { assetId: 2, softwareName: 'CAD 설계 프로그램 LT' },
  ]);
  assert.equal(lic(equal, 10).installed, 2);
  assert.equal(lic(equal, 10).over, false);

  const over = run([
    { assetId: 1, softwareName: 'CAD 설계 프로그램 LT' },
    { assetId: 2, softwareName: 'CAD 설계 프로그램 LT' },
    { assetId: 3, softwareName: 'CAD 설계 프로그램 LT' },
  ]);
  assert.equal(lic(over, 10).over, true);
  assert.equal(lic(over, 10).overBy, 1);
  assert.equal(lic(over, 10).available, -1);
  assert.equal(over.summary.over, 1);
});

test('설치 수: 폐기 자산 제외, 재고·수리 자산 포함, 같은 PC 중복은 1', () => {
  const r = run([
    { assetId: 1, softwareName: '오피스 제품군 2024' },
    { assetId: 1, softwareName: '오피스 제품군 2024 업데이트' }, // 같은 PC
    { assetId: 3, softwareName: '오피스 제품군 2021' }, // 재고
    { assetId: 4, softwareName: '오피스 제품군 2021' }, // 수리
    { assetId: 5, softwareName: '오피스 제품군 2019' }, // 폐기 → 제외
    { assetId: 99, softwareName: '오피스 제품군 2019' }, // 없는 자산 → 제외
  ]);
  assert.equal(lic(r, 12).installed, 3);
  assert.deepEqual(lic(r, 12).assets.map((a) => a.assetTag), ['NB-0001', 'NB-0003', 'NB-0004']);
});

test('비인가 SW: 허용 목록 밖만, 이름별로 묶고, 폐기 자산은 제외, 무료 허용은 제외', () => {
  const r = run([
    { assetId: 1, softwareName: '게임 런처' },
    { assetId: 2, softwareName: '게임  런처 ' }, // 공백 차이 → 같은 SW
    { assetId: 2, softwareName: '개인 웹하드 동기화' },
    { assetId: 5, softwareName: '토렌트 클라이언트' }, // 폐기 PC → 제외
    { assetId: 1, softwareName: '압축 프로그램' }, // 무료 허용
  ]);
  assert.deepEqual(
    r.unauthorized.map((u) => [u.softwareName, u.assetCount]),
    [['게임 런처', 2], ['개인 웹하드 동기화', 1]],
  );
  assert.equal(r.summary.unauthorizedSoftware, 2);
  assert.equal(r.summary.unauthorizedAssets, 2);
  assert.equal(r.unauthorized[0].assets[0].holderName, '가');
});

test('만료 요약: 30일 남은 뷰어 라이선스는 임박으로 집계', () => {
  const r = run([]);
  assert.equal(lic(r, 11).expiry.state, 'EXPIRING');
  assert.equal(r.summary.expiring, 1);
  assert.equal(r.summary.expired, 0);
  assert.equal(lic(r, 12).expiry.state, 'PERPETUAL');
});
