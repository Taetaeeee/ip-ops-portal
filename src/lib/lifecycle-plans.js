// 입·퇴사 자산·라이선스 계획 (순수 함수)
// - 부서 표준 업무 그룹 / 표준 소프트웨어 프로필
// - 소프트웨어 배정: 라이선스가 남았는지 검사 (부족하면 거부)
// - 라이선스 회수: 반납된 PC 의 유료 SW 설치 기록

import { matchAllowlist } from './license-reconcile.js';

// 입사 시 추가할 업무 그룹 (부서 그룹은 계정 생성 때 자동으로 들어간다)
const ROLE_GROUPS_BY_DEPT = {
  EXEC: ['GG-VPN-Users'],
  SALES: ['GG-VPN-Users'],
  PURCH: ['GG-ERP-Purchase'],
  RND: ['GG-FS-Design'],
  LOGI: ['GG-FS-Material'],
};
export function roleGroupsForDept(deptCode) {
  return ['GG-ERP-Users', ...(ROLE_GROUPS_BY_DEPT[deptCode] ?? [])];
}

// 부서 표준 소프트웨어 (설치 기록에 들어갈 이름)
const BASE_SW = ['웹 브라우저', '압축 프로그램', 'ERP 클라이언트', '그룹웨어 메신저', '엔드포인트 백신 v5'];
const OFFICE = '오피스 제품군 2024';
const EXTRA_BY_DEPT = {
  EXEC: [OFFICE, '한글 워드프로세서 2024'],
  MGMT: [OFFICE, '한글 워드프로세서 2024'],
  PURCH: [OFFICE, '한글 워드프로세서 2024'],
  SALES: [OFFICE],
  RND: [OFFICE, 'CAD 설계 프로그램 LT 2025'],
  QC: [OFFICE, '품질검사 성적서 프로그램 v3'],
  MAINT: [OFFICE],
  LOGI: [OFFICE],
  PROD: [], // 생산팀 현장 PC 는 오피스 없음
};
export function softwareProfileForDept(deptCode) {
  return [...BASE_SW, ...(EXTRA_BY_DEPT[deptCode] ?? [])];
}

/**
 * 소프트웨어 배정 계획
 * @param {object} p
 * @param {string[]} p.profile 설치할 SW 이름
 * @param {string[]} p.installedOnDevice 그 PC 에 이미 있는 SW 이름
 * @param {{id, pattern, matchType, licenseId}[]} p.allowlist
 * @param {{id, productName, quantity, installed}[]} p.licenses 대조 결과 (reconcileLicenses().licenses)
 * @returns {{ok: true, installs: {softwareName, licenseId, licenseName}[], skipped: string[]} | {ok: false, httpStatus, code, message, shortages}}
 */
export function planSoftwareAssignment({ profile, installedOnDevice, allowlist, licenses }) {
  const have = new Set(installedOnDevice.map((s) => s.trim().toLowerCase()));
  const licById = new Map(licenses.map((l) => [l.id, l]));
  const alreadyLicensed = new Set(
    installedOnDevice.map((s) => matchAllowlist(s, allowlist)?.licenseId).filter((x) => x != null),
  );
  const installs = [];
  const skipped = [];
  const shortages = [];
  for (const name of profile) {
    if (have.has(name.trim().toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const entry = matchAllowlist(name, allowlist);
    if (!entry) {
      // 표준 프로필에 허용 목록 밖 SW 가 있으면 설정 오류
      return { ok: false, httpStatus: 500, code: 'PROFILE_NOT_ALLOWED', message: `표준 프로필의 ${name} 이(가) 허용 목록에 없습니다`, shortages: [] };
    }
    const lic = entry.licenseId != null ? licById.get(entry.licenseId) : null;
    // 같은 PC 에 이미 같은 라이선스 SW 가 있으면 추가로 쓰지 않는다 (설치 수 = 자산 수)
    if (lic && !alreadyLicensed.has(lic.id) && lic.quantity - lic.installed < 1) {
      shortages.push({ softwareName: name, licenseName: lic.productName, quantity: lic.quantity, installed: lic.installed });
    }
    installs.push({ softwareName: name, licenseId: lic?.id ?? null, licenseName: lic?.productName ?? null });
  }
  if (shortages.length) {
    return {
      ok: false,
      httpStatus: 409,
      code: 'LICENSE_SHORTAGE',
      message: `라이선스 부족: ${shortages.map((s) => `${s.licenseName}(보유 ${s.quantity}, 설치 ${s.installed})`).join(', ')} — 구매하거나 다른 PC 에서 회수해야 합니다`,
      shortages,
    };
  }
  return { ok: true, installs, skipped };
}

/**
 * 라이선스 회수 대상: 반납된 PC 들에 설치된 SW 중 라이선스 대상인 것
 * @param {{id, assetId, assetTag, softwareName}[]} installs 대상 PC 들의 설치 기록 (id = asset_software.id)
 * @param {{id, pattern, matchType, licenseId}[]} allowlist
 * @param {{id, productName}[]} licenses
 */
export function planLicenseReclaim(installs, allowlist, licenses) {
  const name = new Map(licenses.map((l) => [l.id, l.productName]));
  return installs
    .map((s) => ({ ...s, licenseId: matchAllowlist(s.softwareName, allowlist)?.licenseId ?? null }))
    .filter((s) => s.licenseId != null)
    .map((s) => ({ ...s, licenseName: name.get(s.licenseId) ?? null }));
}
