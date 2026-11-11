// 데모 IT 자산 60개·배정 이력·설치 SW·라이선스 8종·허용 목록 (순수 함수)
//
// - 제조사·모델·소프트웨어·계약 업체 이름은 모두 가상의 일반 명칭이다 (실존 제품·회사 정보 아님).
// - 라이선스 만료일만 "초기화 날짜 기준 상대 날짜"로 만든다. 그래야 매일 같은 경고가 나온다.
// - 의도한 경고: 초과 1건(CAD 설계), 만료 임박 1건(PDF 편집기), 비인가 SW 3종(PC 4대)

import { createRng } from './seed-data.js';
import { addDays, kstToday } from './license-reconcile.js';
import { TYPE_PREFIX } from './asset-rules.js';

const IT = 'DT-0004';

// 사무·외근 부서는 노트북, 공장 부서는 데스크톱
const LAPTOP_DEPTS = new Set(['EXEC', 'MGMT', 'SALES', 'PURCH', 'RND', 'MAINT']);

const MODELS = {
  LAPTOP: [['한결컴퓨터', 'HK-Book 14'], ['누리전자', 'NuriBook Pro 15']],
  DESKTOP: [['한결컴퓨터', 'HK-Desk 500'], ['바른정보기기', 'BR-Tower M7']],
};

// 재고·수리·폐기 PC. replacedOn: 이전 사용자가 새 PC로 바꾼 날 (그날 반납)
const POOL = [
  { key: 'spare-nb-new', type: 'LAPTOP', status: 'IN_STOCK', purchasedOn: '2025-08-20' },
  { key: 'spare-nb-old', type: 'LAPTOP', status: 'IN_STOCK', purchasedOn: '2021-04-12', replacedOn: '2025-03-03',
    returnNote: 'PC 교체로 반납. 데이터 삭제·초기화 완료' },
  { key: 'spare-pc-old', type: 'DESKTOP', status: 'IN_STOCK', purchasedOn: '2021-06-01', replacedOn: '2025-03-04',
    returnNote: 'PC 교체로 반납. 데이터 삭제·초기화 완료' },
  { key: 'repair-nb', type: 'LAPTOP', status: 'REPAIR', purchasedOn: '2022-02-10', replacedOn: '2026-10-19',
    returnCondition: 'REPAIR', returnNote: '키보드 일부 키 입력 불량',
    statusNote: '키보드 불량 — 제조사 AS 접수 (예상 2주)', statusChangedOn: '2026-10-19' },
  { key: 'disposed-nb', type: 'LAPTOP', status: 'DISPOSED', purchasedOn: '2018-03-05', replacedOn: '2024-09-02',
    returnNote: '노후 교체', statusNote: '노후(6년) — 저장장치 완전 삭제 후 폐기', statusChangedOn: '2024-10-15' },
  { key: 'disposed-pc', type: 'DESKTOP', status: 'DISPOSED', purchasedOn: '2018-05-21', replacedOn: '2024-09-03',
    returnNote: '노후 교체', statusNote: '메인보드 고장, 수리비가 잔존가치보다 큼 — 폐기', statusChangedOn: '2024-10-15' },
];

// 공용 장비: 사람이 아니라 위치로 관리
const SHARED = [
  { key: 'line-1', type: 'DESKTOP', maker: '바른정보기기', model: 'BR-Mini 3 (산업용)', location: '제1공장 생산라인 1', purchasedOn: '2022-03-14' },
  { key: 'line-2', type: 'DESKTOP', maker: '바른정보기기', model: 'BR-Mini 3 (산업용)', location: '제1공장 생산라인 2', purchasedOn: '2022-03-14' },
  { key: 'line-3', type: 'DESKTOP', maker: '바른정보기기', model: 'BR-Mini 3 (산업용)', location: '제1공장 생산라인 3', purchasedOn: '2023-07-03' },
  { key: 'printer-hq', type: 'PRINTER', maker: '누리전자', model: 'NR-MFP 4500 복합기', location: '본사 2층 사무실', purchasedOn: '2021-09-01' },
  { key: 'printer-prod', type: 'PRINTER', maker: '누리전자', model: 'NR-MFP 3200 복합기', location: '제1공장 생산팀 사무실', purchasedOn: '2020-11-16' },
  { key: 'printer-label', type: 'PRINTER', maker: '바른정보기기', model: 'BL-200 라벨 프린터', location: '제1공장 출하장', purchasedOn: '2023-02-20' },
  { key: 'printer-qc', type: 'PRINTER', maker: '누리전자', model: 'NR-Laser 210 프린터', location: '제1공장 품질관리실', purchasedOn: '2022-05-09' },
  { key: 'firewall', type: 'NETWORK', maker: '온누리네트웍스', model: 'ON-Guard 300 방화벽', location: '본사 전산실', purchasedOn: '2022-01-17' },
  { key: 'switch-hq', type: 'NETWORK', maker: '온누리네트웍스', model: 'ON-Switch 24G', location: '본사 전산실', purchasedOn: '2020-06-08' },
  { key: 'switch-plant', type: 'NETWORK', maker: '온누리네트웍스', model: 'ON-Switch 16G', location: '제1공장 사무동 통신함', purchasedOn: '2019-10-21' },
  { key: 'ap-office', type: 'NETWORK', maker: '온누리네트웍스', model: 'ON-Air 6 무선 AP', location: '본사 2층', purchasedOn: '2023-04-03' },
  { key: 'ap-warehouse', type: 'NETWORK', maker: '온누리네트웍스', model: 'ON-Air 6 Outdoor 무선 AP', location: '제1공장 창고', purchasedOn: '2021-08-30' },
  { key: 'fileserver', type: 'SERVER', maker: '한결컴퓨터', model: 'HK-Server T1 (파일 서버)', location: '본사 전산실', purchasedOn: '2021-02-15' },
  { key: 'nas', type: 'SERVER', maker: '누리전자', model: 'NuriStore 4베이 NAS (백업)', location: '본사 전산실', purchasedOn: '2023-11-06' },
];

// 라이선스 8종. expiresIn: 초기화 날짜 기준 며칠 뒤 만료 (null = 영구)
const LICENSES = [
  { id: 1, productName: '오피스 제품군', vendor: '누리소프트 유통', licenseType: 'PERPETUAL', quantity: 35, expiresIn: null, contractNo: 'NS-2023-0141' },
  { id: 2, productName: '한글 워드프로세서', vendor: '한결정보기술', licenseType: 'PERPETUAL', quantity: 12, expiresIn: null, contractNo: 'HG-2022-0087' },
  { id: 3, productName: 'PDF 편집기 Pro (구독)', vendor: '누리소프트 유통', licenseType: 'SUBSCRIPTION', quantity: 5, expiresIn: 20, contractNo: 'NS-2025-0310' },
  { id: 4, productName: 'CAD 설계 프로그램 LT (구독)', vendor: '바른솔루션', licenseType: 'SUBSCRIPTION', quantity: 3, expiresIn: 200, contractNo: 'BS-2025-0052' },
  { id: 5, productName: '엔드포인트 백신', vendor: '온새미로 시큐리티', licenseType: 'SUBSCRIPTION', quantity: 45, expiresIn: 150, contractNo: 'OS-2025-1102' },
  { id: 6, productName: 'CAD 뷰어 Plus (구독)', vendor: '바른솔루션', licenseType: 'SUBSCRIPTION', quantity: 5, expiresIn: 300, contractNo: 'BS-2025-0053' },
  { id: 7, productName: '원격 지원 도구 Business', vendor: '온새미로 시큐리티', licenseType: 'SUBSCRIPTION', quantity: 2, expiresIn: 90, contractNo: 'OS-2025-1150' },
  { id: 8, productName: '품질검사 성적서 프로그램', vendor: '바른계측시스템', licenseType: 'PERPETUAL', quantity: 3, expiresIn: null, contractNo: 'BG-2024-0019' },
];

const ALLOWLIST = [
  { id: 1, pattern: '오피스 제품군', matchType: 'PREFIX', licenseId: 1, note: null },
  { id: 2, pattern: '한글 워드프로세서', matchType: 'PREFIX', licenseId: 2, note: null },
  { id: 3, pattern: 'PDF 편집기', matchType: 'PREFIX', licenseId: 3, note: null },
  { id: 4, pattern: 'CAD 설계 프로그램', matchType: 'PREFIX', licenseId: 4, note: null },
  { id: 5, pattern: '엔드포인트 백신', matchType: 'PREFIX', licenseId: 5, note: null },
  { id: 6, pattern: 'CAD 뷰어', matchType: 'PREFIX', licenseId: 6, note: null },
  { id: 7, pattern: '원격 지원 도구', matchType: 'PREFIX', licenseId: 7, note: '정/부 IT 담당자만' },
  { id: 8, pattern: '품질검사 성적서', matchType: 'PREFIX', licenseId: 8, note: null },
  { id: 9, pattern: '데스크톱 운영체제', matchType: 'PREFIX', licenseId: null, note: 'PC 구매 시 포함(OEM)' },
  { id: 10, pattern: '웹 브라우저', matchType: 'PREFIX', licenseId: null, note: '무료' },
  { id: 11, pattern: '압축 프로그램', matchType: 'EXACT', licenseId: null, note: '무료' },
  { id: 12, pattern: 'ERP 클라이언트', matchType: 'PREFIX', licenseId: null, note: '사내 시스템' },
  { id: 13, pattern: '그룹웨어 메신저', matchType: 'PREFIX', licenseId: null, note: '사내 시스템' },
];

// 사번별 추가 설치 (부서 기본 설치 외)
const EXTRA_SW = {
  'DT-0003': ['PDF 편집기 Pro', '원격 지원 도구 Business'],
  'DT-0004': ['PDF 편집기 Pro', '원격 지원 도구 Business'],
  'DT-0008': ['PDF 편집기 Pro'],
  'DT-0014': ['PDF 편집기 Pro'],
  'DT-0021': ['CAD 뷰어 Plus'],
  'DT-0031': ['CAD 뷰어 Plus'],
  'DT-0035': ['CAD 뷰어 Plus'],
  'DT-0032': ['품질검사 성적서 프로그램 v3'],
  'DT-0033': ['품질검사 성적서 프로그램 v3'],
  // 비인가 SW (허용 목록에 없음)
  'DT-0011': ['개인용 원격제어 도구 Free'],
  'DT-0027': ['개인용 원격제어 도구 Free'],
  'DT-0019': ['개인 웹하드 동기화'],
};

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function randomDate(rng, fromYear, toYear) {
  const y = fromYear + Math.floor(rng() * (toYear - fromYear + 1));
  return `${y}-${pad(1 + Math.floor(rng() * 12), 2)}-${pad(1 + Math.floor(rng() * 28), 2)}`;
}

// KST 09:00 / 09:30 / 10:00 을 UTC ISO 로 (PC 교체일: 09:00 이전 PC 반납 → 09:30 새 PC 배정)
const at0900 = (ymd) => `${ymd}T00:00:00.000Z`;
const at0930 = (ymd) => `${ymd}T00:30:00.000Z`;
const at1000 = (ymd) => `${ymd}T01:00:00.000Z`;
const maxYmd = (a, b) => (a > b ? a : b);

/**
 * @param {{employees: {empNo, deptCode, hireDate}[], now: Date, seed?: number}} p
 */
export function generateDemoAssets({ employees, now, seed = 7310 }) {
  const rng = createRng(seed);
  const today = kstToday(now);
  const assets = [];
  const assignments = [];
  const software = [];
  const usedSerials = new Set();
  const counters = {};

  const serial = (maker) => {
    for (;;) {
      const s = `${maker === '한결컴퓨터' ? 'HK' : maker === '누리전자' ? 'NR' : maker === '바른정보기기' ? 'BR' : 'ON'}${Math.floor(rng() * 36 ** 8)
        .toString(36)
        .toUpperCase()
        .padStart(8, '0')}`;
      if (!usedSerials.has(s)) {
        usedSerials.add(s);
        return s;
      }
    }
  };
  const addAsset = (a) => {
    counters[a.type] = (counters[a.type] ?? 0) + 1;
    const asset = {
      id: assets.length + 1,
      key: a.key,
      assetTag: `${TYPE_PREFIX[a.type]}-${pad(counters[a.type], 4)}`,
      assetType: a.type,
      manufacturer: a.maker,
      model: a.model,
      serialNo: serial(a.maker),
      purchasedOn: a.purchasedOn,
      status: a.status,
      location: a.location ?? null,
      statusNote: a.statusNote ?? null,
      statusChangedAt: a.statusChangedOn ? at1000(a.statusChangedOn) : null,
      version: 1,
    };
    assets.push(asset);
    return asset;
  };
  const install = (assetId, name, installedOn) => {
    const m = /^(.*?)(?:\s+(v?\d[\w.]*))?$/.exec(name);
    software.push({ assetId, softwareName: name, version: m?.[2] ?? null, installedOn });
  };
  const pickModel = (type) => MODELS[type][Math.floor(rng() * MODELS[type].length)];

  // 이전 사용자: PC 종류가 같은 직원 중 입사가 빠른 순 (IT 담당자 제외)
  const byHire = [...employees].sort((a, b) => a.hireDate.localeCompare(b.hireDate) || a.empNo.localeCompare(b.empNo));
  const personalType = (e) => (LAPTOP_DEPTS.has(e.deptCode) ? 'LAPTOP' : 'DESKTOP');
  const prevHolder = new Map(); // pool key → employee
  const taken = new Set([IT, 'DT-0003']);
  for (const p of POOL.filter((x) => x.replacedOn)) {
    const e = byHire.find((x) => !taken.has(x.empNo) && personalType(x) === p.type && x.hireDate < p.replacedOn);
    taken.add(e.empNo);
    prevHolder.set(p.key, e);
  }
  const replacedOnOf = new Map([...prevHolder].map(([key, e]) => [e.empNo, POOL.find((p) => p.key === key).replacedOn]));

  // 1) 직원 1명당 개인 PC 1대 (사용 중)
  for (const e of employees) {
    const type = personalType(e);
    const [maker, model] = pickModel(type);
    const purchasedOn = replacedOnOf.get(e.empNo) ?? randomDate(rng, 2022, 2025);
    const asset = addAsset({ type, maker, model, purchasedOn, status: 'IN_USE' });
    const assignedOn = maxYmd(e.hireDate, purchasedOn);
    assignments.push({
      assetId: asset.id, empNo: e.empNo, assignedAt: at0930(assignedOn), assignedBy: IT,
      assignNote: replacedOnOf.has(e.empNo) ? 'PC 교체' : '지급',
      returnedAt: null, returnedBy: null, returnCondition: null, returnNote: null,
    });

    const sw = ['데스크톱 운영체제 Pro 64비트', '웹 브라우저', '압축 프로그램', 'ERP 클라이언트', '그룹웨어 메신저', '엔드포인트 백신 v5'];
    const isProdMember = e.deptCode === 'PROD' && !['DT-0021', 'DT-0022'].includes(e.empNo);
    if (!isProdMember) sw.push(purchasedOn >= '2024-01-01' ? '오피스 제품군 2024' : '오피스 제품군 2021');
    if (['EXEC', 'MGMT', 'PURCH'].includes(e.deptCode)) sw.push('한글 워드프로세서 2024');
    if (e.deptCode === 'RND') sw.push('CAD 설계 프로그램 LT 2025');
    sw.push(...(EXTRA_SW[e.empNo] ?? []));
    for (const name of sw) install(asset.id, name, assignedOn);
  }

  // 2) 재고·수리·폐기 PC
  for (const p of POOL) {
    const [maker, model] = pickModel(p.type);
    const asset = addAsset({ ...p, maker, model });
    const holder = prevHolder.get(p.key);
    if (holder) {
      assignments.push({
        assetId: asset.id, empNo: holder.empNo, assignedAt: at0930(maxYmd(holder.hireDate, p.purchasedOn)), assignedBy: IT,
        assignNote: '지급', returnedAt: at0900(p.replacedOn), returnedBy: IT,
        returnCondition: p.returnCondition ?? 'IN_STOCK', returnNote: p.returnNote,
      });
    }
    install(asset.id, '데스크톱 운영체제 Pro 64비트', p.purchasedOn);
    install(asset.id, '웹 브라우저', p.purchasedOn);
    if (p.status === 'REPAIR') {
      // 수리 중인 노트북은 SW 가 그대로 남아 있다 → 라이선스 수에 포함
      for (const n of ['엔드포인트 백신 v5', '오피스 제품군 2021', 'ERP 클라이언트']) install(asset.id, n, p.purchasedOn);
    }
    if (p.status === 'DISPOSED') {
      // 폐기 PC 의 기록 → 라이선스·비인가 집계에서 빠져야 한다
      for (const n of ['엔드포인트 백신 v4', '오피스 제품군 2016']) install(asset.id, n, p.purchasedOn);
      if (p.key === 'disposed-pc') install(asset.id, '게임 런처', p.purchasedOn);
    }
  }

  // 3) 공용 장비
  for (const s of SHARED) {
    const asset = addAsset({ ...s, maker: s.maker, status: 'IN_USE' });
    if (s.type === 'DESKTOP') {
      for (const n of ['데스크톱 운영체제 Pro 64비트', '웹 브라우저', 'ERP 클라이언트', '엔드포인트 백신 v5']) install(asset.id, n, s.purchasedOn);
      if (s.key === 'line-2') install(asset.id, '게임 런처', '2026-06-12'); // 비인가 (공용 PC)
    }
  }

  const licenses = LICENSES.map(({ expiresIn, ...l }) => ({ ...l, expiresOn: expiresIn === null ? null : addDays(today, expiresIn) }));
  return { today, assets, assignments, software, licenses, allowlist: ALLOWLIST.map((a) => ({ ...a })) };
}

/** 데모 티켓 연결용: 'holder' 는 요청자의 개인 PC, 그 외는 공용 장비 key */
export function resolveDemoAsset(inventory, ref, requesterEmpNo) {
  if (!inventory || !ref) return null;
  if (ref === 'holder') {
    return inventory.assignments.find((x) => x.empNo === requesterEmpNo && x.returnedAt === null)?.assetId ?? null;
  }
  return inventory.assets.find((a) => a.key === ref)?.id ?? null;
}
