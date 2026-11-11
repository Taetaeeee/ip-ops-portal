// 가상 AD 디렉터리 모델 (순수 함수): 도메인, OU 트리, 보안 그룹, DN 만들기
//
// DN(distinguishedName) = 디렉터리 안의 전체 경로. 오른쪽으로 갈수록 상위.
//   CN=홍길동,OU=영업팀,OU=본사,OU=부서별 사용자,DC=corp,DC=ossan,DC=example
// OU 는 "관리 단위(폴더)"다. GPO 적용과 관리 권한 위임에 쓰고, 파일 권한은 그룹에 준다.

import { DEPARTMENTS } from './seed-data.js';

export const DOMAIN = Object.freeze({
  dns: 'corp.ossan.example', // RFC 2606 예약 도메인 (.example) → 실제로 존재할 수 없다
  netbios: 'OSSAN',
  dn: 'DC=corp,DC=ossan,DC=example',
});

/**
 * DN 의 값(RDN 값) 이스케이프 (RFC 4514).
 * , + " \ < > ; = 앞에 \ 를 붙이고, 맨 앞의 # 이나 공백, 맨 뒤 공백도 이스케이프한다.
 * 예: 'Kim, Jr.' → 'Kim\, Jr.'  (이스케이프하지 않으면 쉼표가 경로 구분자로 읽힌다)
 */
export function escapeDnValue(value) {
  let s = String(value).replace(/[\\,+"<>;=]/g, (c) => `\\${c}`);
  if (s.startsWith('#') || s.startsWith(' ')) s = `\\${s}`;
  if (s.length > 1 && s.endsWith(' ') && !s.endsWith('\\ ')) s = `${s.slice(0, -1)}\\ `;
  return s;
}

// OU 트리. leaf: 사용자를 둘 수 있는 OU
const DEPT_OUS = DEPARTMENTS.map((d) => ({
  key: d.code,
  name: d.name,
  parent: d.siteCode === 'HQ' ? 'HQ' : 'PLANT1',
  kind: 'DEPT',
  leaf: true,
}));

export const OUS = Object.freeze([
  { key: 'USERS', name: '부서별 사용자', parent: null, kind: 'ROOT', leaf: false },
  { key: 'HQ', name: '본사', parent: 'USERS', kind: 'SITE', leaf: false },
  { key: 'PLANT1', name: '제1공장', parent: 'USERS', kind: 'SITE', leaf: false },
  ...DEPT_OUS,
  { key: 'FORMER', name: '퇴사자', parent: null, kind: 'FORMER', leaf: true },
  { key: 'SERVICE', name: '서비스 계정', parent: null, kind: 'SERVICE', leaf: true },
  { key: 'GROUPS', name: '보안 그룹', parent: null, kind: 'GROUPS', leaf: false },
]);

const OU_BY_KEY = new Map(OUS.map((o) => [o.key, o]));

export const isOuKey = (k) => typeof k === 'string' && OU_BY_KEY.has(k);
export const getOu = (k) => OU_BY_KEY.get(k) ?? null;

/** 사용자를 둘 수 있는 OU (부서 OU, 퇴사자, 서비스 계정) */
export const USER_OU_KEYS = Object.freeze(OUS.filter((o) => o.leaf).map((o) => o.key));

export function ouDn(key) {
  const ou = OU_BY_KEY.get(key);
  if (!ou) throw new RangeError(`없는 OU: ${key}`);
  const self = `OU=${escapeDnValue(ou.name)}`;
  return ou.parent ? `${self},${ouDn(ou.parent)}` : `${self},${DOMAIN.dn}`;
}

/** OU 경로를 사람이 읽기 좋게: 부서별 사용자 › 본사 › 영업팀 */
export function ouPath(key) {
  const ou = OU_BY_KEY.get(key);
  return ou.parent ? `${ouPath(ou.parent)} › ${ou.name}` : ou.name;
}

export function userDn(cn, ouKey) {
  return `CN=${escapeDnValue(cn)},${ouDn(ouKey)}`;
}

export function upnOf(sam) {
  return `${sam}@${DOMAIN.dns}`;
}

// 보안 그룹: 전부 전역(Global) 보안 그룹. 그룹 중첩(AGDLP)은 이 시뮬레이터에서 생략한다.
const DEPT_GROUP_SUFFIX = {
  EXEC: 'Exec', MGMT: 'Mgmt', SALES: 'Sales', PURCH: 'Purch', RND: 'RnD',
  PROD: 'Prod', QC: 'QC', MAINT: 'Maint', LOGI: 'Logi',
};

export const GROUPS = Object.freeze([
  ...DEPARTMENTS.map((d) => ({
    sam: `GG-Dept-${DEPT_GROUP_SUFFIX[d.code]}`,
    kind: 'DEPT',
    deptCode: d.code,
    description: `${d.name} 부서 그룹`,
  })),
  { sam: 'GG-ERP-Users', kind: 'ROLE', description: 'ERP 접속 권한' },
  { sam: 'GG-ERP-Purchase', kind: 'ROLE', description: 'ERP 구매·발주 메뉴 권한' },
  { sam: 'GG-FS-Design', kind: 'ROLE', description: '파일 서버 \\\\fileserver\\도면 읽기·쓰기' },
  { sam: 'GG-FS-Material', kind: 'ROLE', description: '파일 서버 \\\\fileserver\\자재 읽기·쓰기' },
  { sam: 'GG-VPN-Users', kind: 'ROLE', description: '외부 VPN 접속 허용' },
  { sam: 'GG-IT-Helpdesk', kind: 'ROLE', description: '사용자 OU 비밀번호 초기화·잠금 해제·계정 관리 위임' },
]);

export const deptGroupSam = (deptCode) => `GG-Dept-${DEPT_GROUP_SUFFIX[deptCode]}`;

export function groupDn(sam) {
  return `CN=${escapeDnValue(sam)},${ouDn('GROUPS')}`;
}
