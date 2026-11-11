// 라이선스 대조 (순수 함수)
//
// 질문 세 가지에 답한다.
// 1) 보유 수량보다 많이 설치했나? (초과 → 감사·벌금 위험)
// 2) 곧 만료되나? (만료 30일 전부터 경고 → 갱신 결재 시간 확보)
// 3) 허용 목록에 없는 프로그램이 깔려 있나? (비인가 SW → 보안·저작권 위험)
//
// 규칙
// - 설치 수 = 그 라이선스에 해당하는 SW 가 깔린 "자산 수" (같은 PC 에 두 번 잡혀도 1)
// - 폐기 자산은 세지 않는다. 재고·수리 자산은 센다 (SW 를 지워야 라이선스가 돌아온다)
// - 이름 비교 전 정리: 유니코드 정규화, 앞뒤 공백 제거, 연속 공백 하나로, 소문자
// - 허용 목록 매칭: 정확히 일치(EXACT)를 먼저, 없으면 가장 긴 앞부분 일치(PREFIX)

export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPIRY_STATES = Object.freeze({
  PERPETUAL: '영구',
  OK: '정상',
  EXPIRING: '만료 임박',
  EXPIRED: '만료',
});

export function normalizeSoftwareName(name) {
  return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** KST 기준 오늘 날짜 'YYYY-MM-DD' */
export function kstToday(now, offsetMinutes = 9 * 60) {
  return new Date(now.getTime() + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

function ymdToUtc(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 날짜 더하기: addDays('2026-11-12', 20) → '2026-12-02' */
export function addDays(ymd, days) {
  return new Date(ymdToUtc(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 만료일까지 남은 날 수 (오늘 만료 = 0, 어제 만료 = -1) */
export function daysUntil(expiresOn, today) {
  return Math.round((ymdToUtc(expiresOn) - ymdToUtc(today)) / DAY_MS);
}

export function expiryState(expiresOn, today, warningDays = EXPIRY_WARNING_DAYS) {
  if (!expiresOn) return { state: 'PERPETUAL', daysLeft: null };
  const daysLeft = daysUntil(expiresOn, today);
  if (Number.isNaN(daysLeft)) return { state: 'EXPIRED', daysLeft: null }; // 날짜를 해석할 수 없으면 안전하게 만료로
  if (daysLeft < 0) return { state: 'EXPIRED', daysLeft };
  if (daysLeft <= warningDays) return { state: 'EXPIRING', daysLeft };
  return { state: 'OK', daysLeft };
}

/**
 * 허용 목록에서 맞는 항목 찾기
 * @param {string} softwareName
 * @param {{id, pattern, matchType, licenseId}[]} allowlist
 */
export function matchAllowlist(softwareName, allowlist) {
  const name = normalizeSoftwareName(softwareName);
  if (!name) return null;
  let best = null;
  for (const entry of allowlist) {
    const pattern = normalizeSoftwareName(entry.pattern);
    if (!pattern) continue;
    if (entry.matchType === 'EXACT' && name === pattern) return entry;
    if (entry.matchType === 'PREFIX' && name.startsWith(pattern)) {
      if (!best || pattern.length > normalizeSoftwareName(best.pattern).length) best = entry;
    }
  }
  return best;
}

/**
 * @param {object} p
 * @param {{id, productName, vendor, licenseType, quantity, expiresOn}[]} p.licenses
 * @param {{id, pattern, matchType, licenseId}[]} p.allowlist
 * @param {{assetId, softwareName, version?}[]} p.installs
 * @param {{id, assetTag, status, holderName?, location?}[]} p.assets
 * @param {string} p.today KST 'YYYY-MM-DD'
 */
export function reconcileLicenses({ licenses, allowlist, installs, assets, today, warningDays = EXPIRY_WARNING_DAYS }) {
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const counted = (assetId) => {
    const a = assetById.get(assetId);
    return a && a.status !== 'DISPOSED';
  };

  const installedAssets = new Map(licenses.map((l) => [l.id, new Set()]));
  const unauthorized = new Map(); // 정리된 이름 → { softwareName, assetIds:Set }

  for (const inst of installs) {
    if (!counted(inst.assetId)) continue;
    const entry = matchAllowlist(inst.softwareName, allowlist);
    if (!entry) {
      const key = normalizeSoftwareName(inst.softwareName);
      if (!key) continue;
      if (!unauthorized.has(key)) unauthorized.set(key, { softwareName: inst.softwareName.trim(), assetIds: new Set() });
      unauthorized.get(key).assetIds.add(inst.assetId);
    } else if (entry.licenseId != null && installedAssets.has(entry.licenseId)) {
      installedAssets.get(entry.licenseId).add(inst.assetId);
    }
  }

  const assetView = (id) => {
    const a = assetById.get(id);
    return { id, assetTag: a.assetTag, holderName: a.holderName ?? null, location: a.location ?? null };
  };
  const byTag = (x, y) => x.assetTag.localeCompare(y.assetTag);

  const licenseRows = licenses.map((l) => {
    const ids = [...installedAssets.get(l.id)];
    const installed = ids.length;
    return {
      ...l,
      installed,
      available: l.quantity - installed,
      over: installed > l.quantity,
      overBy: Math.max(0, installed - l.quantity),
      expiry: expiryState(l.expiresOn, today, warningDays),
      assets: ids.map(assetView).sort(byTag),
    };
  });

  const unauthorizedRows = [...unauthorized.values()]
    .map((u) => ({ softwareName: u.softwareName, assetCount: u.assetIds.size, assets: [...u.assetIds].map(assetView).sort(byTag) }))
    .sort((a, b) => b.assetCount - a.assetCount || a.softwareName.localeCompare(b.softwareName));

  return {
    today,
    licenses: licenseRows,
    unauthorized: unauthorizedRows,
    summary: {
      over: licenseRows.filter((l) => l.over).length,
      expiring: licenseRows.filter((l) => l.expiry.state === 'EXPIRING').length,
      expired: licenseRows.filter((l) => l.expiry.state === 'EXPIRED').length,
      unauthorizedSoftware: unauthorizedRows.length,
      unauthorizedAssets: new Set(unauthorizedRows.flatMap((u) => u.assets.map((a) => a.id))).size,
    },
  };
}
