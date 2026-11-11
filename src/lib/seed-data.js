// 가상 회사 "도담테크산업"의 기본 데이터를 만드는 순수 함수.
//
// - DB나 시계, Math.random 에 의존하지 않는다. 같은 시드 → 항상 같은 결과.
//   그래서 매일 초기화해도 데모 데이터가 똑같이 돌아오고, 테스트도 쉽다.
// - 모든 이름·사번·내선은 가상이다. 실존 인물과 연결되지 않는다.

export const COMPANY = Object.freeze({
  name: '도담테크산업',
  shortName: 'DODAMTECH',
  business: '자동차·가전용 프레스 부품 제조',
});

export const DEFAULT_SEED = 4030;

export const SITES = Object.freeze([
  { code: 'HQ', name: '본사', kind: 'HQ', sortOrder: 1, extensionBase: 200 },
  { code: 'PLANT1', name: '제1공장', kind: 'PLANT', sortOrder: 2, extensionBase: 500 },
]);

// 부서와 인원. 합계 40명 (본사 20, 공장 20)
// leadTitle: 팀장 직급. 임원실은 고정 직급 목록(fixedTitles)을 쓴다.
export const DEPARTMENTS = Object.freeze([
  { code: 'EXEC', name: '임원실', siteCode: 'HQ', headcount: 2, fixedTitles: ['대표이사', '이사'] },
  { code: 'MGMT', name: '경영지원팀', siteCode: 'HQ', headcount: 5, leadTitle: '부장' },
  { code: 'SALES', name: '영업팀', siteCode: 'HQ', headcount: 6, leadTitle: '부장' },
  { code: 'PURCH', name: '구매팀', siteCode: 'HQ', headcount: 3, leadTitle: '차장' },
  { code: 'RND', name: '연구개발팀', siteCode: 'HQ', headcount: 4, leadTitle: '차장' },
  { code: 'PROD', name: '생산팀', siteCode: 'PLANT1', headcount: 10, leadTitle: '부장' },
  { code: 'QC', name: '품질관리팀', siteCode: 'PLANT1', headcount: 4, leadTitle: '차장' },
  { code: 'MAINT', name: '설비보전팀', siteCode: 'PLANT1', headcount: 3, leadTitle: '차장' },
  { code: 'LOGI', name: '자재물류팀', siteCode: 'PLANT1', headcount: 3, leadTitle: '차장' },
]);

// 데모 페르소나가 연결되는 직원 (사번은 아래 생성 순서로 고정된다)
// - IT 담당자: 경영지원팀 두 번째 직원 (중소 제조사에서 흔한 "관리부 겸 전산 담당")
// - 일반 직원: 영업팀 두 번째 직원
export const IT_DUTY = '전산·IT 운영';
export const PERSONA_EMP_NO = Object.freeze({
  it_admin: 'DT-0004',
  employee: 'DT-0009',
});

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '전'];
const GIVEN_FIRST = ['민', '서', '지', '현', '수', '예', '도', '하', '준', '유', '승', '은', '태', '재', '성', '다', '소', '건', '시', '나'];
const GIVEN_SECOND = ['준', '연', '우', '진', '아', '호', '윤', '빈', '원', '희', '훈', '린', '혁', '경', '율', '영', '람', '석', '결', '온'];

// 팀원 직급 분포 (앞쪽일수록 덜 뽑힌다)
const MEMBER_TITLES = ['과장', '대리', '대리', '주임', '주임', '사원', '사원', '사원'];

// 시드 기반 의사 난수 생성기(mulberry32). 0 이상 1 미만의 수를 돌려준다.
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

// 직급별 입사 연도 범위 (높은 직급일수록 오래 근무)
function hireYearRange(title) {
  switch (title) {
    case '대표이사': return [2003, 2005];
    case '이사': return [2005, 2009];
    case '부장': return [2008, 2012];
    case '차장': return [2010, 2014];
    case '과장': return [2013, 2017];
    case '대리': return [2017, 2020];
    case '주임': return [2020, 2022];
    default: return [2022, 2025];
  }
}

function randomHireDate(rng, title) {
  const [from, to] = hireYearRange(title);
  const year = randomInt(rng, from, to);
  const month = randomInt(rng, 1, 12);
  const day = randomInt(rng, 1, 28); // 28일까지만 써서 없는 날짜(2월 30일 등)를 피한다
  return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
}

function uniqueName(rng, used) {
  for (let i = 0; i < 1000; i++) {
    const name = pick(rng, SURNAMES) + pick(rng, GIVEN_FIRST) + pick(rng, GIVEN_SECOND);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  throw new Error('가상 이름 생성 실패: 조합이 부족합니다');
}

// 직급 결정: 임원실은 고정, 그 외는 첫 번째가 팀장, 나머지는 분포에서 뽑는다.
// 경영지원팀 두 번째(IT 담당)는 실무 담당이 자연스럽도록 '대리'로 고정한다.
function titleFor(rng, dept, indexInDept) {
  if (dept.fixedTitles) return dept.fixedTitles[indexInDept];
  if (indexInDept === 0) return dept.leadTitle;
  if (dept.code === 'MGMT' && indexInDept === 1) return '대리';
  return pick(rng, MEMBER_TITLES);
}

/**
 * 가상 회사 데이터 전체를 만든다.
 * @param {number} seed
 * @returns {{company, sites, departments, employees}}
 */
export function generateSeedData(seed = DEFAULT_SEED) {
  const rng = createRng(seed);
  const usedNames = new Set();
  const extensionCounter = Object.fromEntries(SITES.map((s) => [s.code, s.extensionBase]));

  const sites = SITES.map(({ code, name, kind, sortOrder }) => ({ code, name, kind, sortOrder }));
  const departments = DEPARTMENTS.map((d, i) => ({
    code: d.code,
    name: d.name,
    siteCode: d.siteCode,
    sortOrder: i + 1,
  }));

  const employees = [];
  let seq = 0;
  for (const dept of DEPARTMENTS) {
    for (let i = 0; i < dept.headcount; i++) {
      seq += 1;
      const empNo = `DT-${pad(seq, 4)}`;
      const jobTitle = titleFor(rng, dept, i);
      extensionCounter[dept.siteCode] += 1;
      employees.push({
        empNo,
        name: uniqueName(rng, usedNames),
        deptCode: dept.code,
        jobTitle,
        isTeamLead: !dept.fixedTitles && i === 0,
        duty: empNo === PERSONA_EMP_NO.it_admin ? IT_DUTY : null,
        hireDate: randomHireDate(rng, jobTitle),
        extension: String(extensionCounter[dept.siteCode]),
      });
    }
  }

  return { company: { ...COMPANY }, sites, departments, employees };
}
