// 계정 이름 규칙 (순수 함수)
//
// sAMAccountName 규칙 (실제 AD)
// - 20자 이하 (사용자 계정의 옛 호환 한도)
// - 쓸 수 없는 문자: " / \ [ ] : ; | = , + * ? < > @ 와 제어 문자
// - 도메인 전체에서 대소문자 구분 없이 유일 (그룹 이름과도 겹치면 안 된다)
//
// 회사 규칙: 영문 이름 머리글자 + 성. 홍길동 → gdhong, 중복이면 gdhong2, gdhong3 …

export const SAM_MAX = 20;
const SAM_FORBIDDEN = /["/\\[\]:;|=,+*?<>@]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// 한글 로마자 표기 (국어의 로마자 표기법, 음절 단위. 음운 변화는 반영하지 않음)
const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];

// 성은 표기법 대신 관용 표기를 쓴다 (김 → kim. 표기법대로면 gim)
const SURNAMES = {
  김: 'kim', 이: 'lee', 박: 'park', 최: 'choi', 정: 'jung', 강: 'kang', 조: 'cho', 윤: 'yoon', 장: 'jang', 임: 'lim',
  한: 'han', 오: 'oh', 서: 'seo', 신: 'shin', 권: 'kwon', 황: 'hwang', 안: 'ahn', 송: 'song', 류: 'ryu', 전: 'jeon',
  홍: 'hong', 유: 'yoo', 고: 'ko', 문: 'moon', 양: 'yang', 손: 'son', 배: 'bae', 백: 'baek', 허: 'heo', 남: 'nam',
  노: 'noh', 하: 'ha', 곽: 'kwak', 성: 'sung', 차: 'cha', 주: 'joo', 우: 'woo', 구: 'koo', 민: 'min', 진: 'jin',
  지: 'ji', 엄: 'eom', 채: 'chae', 원: 'won', 천: 'cheon', 방: 'bang', 공: 'kong', 현: 'hyun', 함: 'ham', 변: 'byun',
  염: 'yeom', 여: 'yeo', 추: 'choo', 도: 'do', 석: 'seok', 선: 'sun', 설: 'seol', 마: 'ma', 길: 'gil', 연: 'yeon',
  표: 'pyo', 명: 'myung', 기: 'ki', 반: 'ban', 왕: 'wang', 금: 'keum', 옥: 'ok', 육: 'yook', 인: 'in', 맹: 'maeng',
  제갈: 'jegal', 남궁: 'namgung', 황보: 'hwangbo', 선우: 'sunwoo', 독고: 'dokgo', 사공: 'sagong', 서문: 'seomun',
};
const COMPOUND_SURNAMES = Object.keys(SURNAMES).filter((s) => s.length === 2);

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

/** 한글 음절 하나를 로마자로 (한글이 아니면 그대로) */
export function romanizeSyllable(ch) {
  const code = ch.codePointAt(0);
  if (code < HANGUL_START || code > HANGUL_END) return ch;
  const idx = code - HANGUL_START;
  return INITIALS[Math.floor(idx / 588)] + MEDIALS[Math.floor((idx % 588) / 28)] + FINALS[idx % 28];
}

export function romanize(text) {
  return [...String(text)].map(romanizeSyllable).join('');
}

/** 한글 이름을 성/이름으로 나눈다. 복성(남궁·제갈 등)은 3글자 이상일 때만 */
export function splitKoreanName(fullName) {
  const name = String(fullName).trim();
  const compound = COMPOUND_SURNAMES.find((s) => name.startsWith(s) && name.length >= 3);
  const surname = compound ?? name.slice(0, 1);
  return { surname, givenName: name.slice(surname.length) };
}

export function romanizeSurname(surname) {
  return SURNAMES[surname] ?? romanize(surname);
}

const asciiLower = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 계정명 기본형: 이름 머리글자 + 성
 * - 한글 이름: 이름 음절마다 로마자 첫 글자 (길동 → g, d)
 * - 영문 이름을 직접 입력(여권 표기 등): '-' 나 공백으로 나뉜 부분마다 첫 글자 (Gil-dong → g, d)
 */
export function baseSamFor({ surname, givenName, surnameEn, givenNameEn }) {
  const sur = asciiLower(surnameEn ? surnameEn : romanizeSurname(surname ?? ''));
  let initials;
  if (givenNameEn) {
    initials = String(givenNameEn)
      .split(/[-\s]+/)
      .filter(Boolean)
      .map((p) => asciiLower(p).charAt(0))
      .join('');
  } else {
    initials = [...String(givenName ?? '')].map((ch) => asciiLower(romanizeSyllable(ch)).charAt(0)).join('');
  }
  return `${initials}${sur}`;
}

/**
 * 중복을 피해 계정명을 만든다. 이미 있으면 숫자를 붙인다 (gdhong → gdhong2 → gdhong3)
 * @param {string} base
 * @param {Set<string>} takenLower 이미 쓰는 이름 (소문자). 사용자 + 그룹 모두
 */
export function uniqueSam(base, takenLower) {
  const clean = asciiLower(base) || 'user';
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : String(n);
    const candidate = clean.slice(0, SAM_MAX - suffix.length) + suffix; // 20자를 넘으면 앞부분을 줄인다
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('계정명을 만들 수 없습니다');
}

/** sAMAccountName 검증. 문제가 없으면 null, 있으면 이유 */
export function samProblem(sam) {
  if (typeof sam !== 'string' || sam.length === 0) return '계정명이 비어 있습니다';
  if (sam.length > SAM_MAX) return `계정명은 ${SAM_MAX}자 이하여야 합니다`;
  if (CONTROL.test(sam) || SAM_FORBIDDEN.test(sam)) return '계정명에 쓸 수 없는 문자가 있습니다 (" / \\ [ ] : ; | = , + * ? < > @)';
  if (/^[.\s]+$/.test(sam) || sam.endsWith('.')) return '계정명은 점이나 공백만으로 이루어지거나 점으로 끝날 수 없습니다';
  return null;
}

/** 이름 같은 일반 입력: 제어 문자(줄바꿈 등) 금지, 길이 제한 */
export function textProblem(value, { label, max = 64, required = true }) {
  if (value === undefined || value === null || String(value).trim() === '') return required ? `${label}을(를) 입력해야 합니다` : null;
  if (typeof value !== 'string') return `${label}은(는) 문자열이어야 합니다`;
  if (CONTROL.test(value)) return `${label}에 줄바꿈 같은 제어 문자를 쓸 수 없습니다`;
  if (value.trim().length > max) return `${label}은(는) ${max}자 이하여야 합니다`;
  return null;
}
