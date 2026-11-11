import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  romanize,
  splitKoreanName,
  romanizeSurname,
  baseSamFor,
  uniqueSam,
  samProblem,
  textProblem,
  SAM_MAX,
} from '../src/lib/ad-naming.js';
import { escapeDnValue, userDn, ouDn, upnOf, OUS, GROUPS, groupDn } from '../src/lib/ad-model.js';

test('로마자 표기 (음절 단위): 받침·이중모음', () => {
  assert.equal(romanize('길동'), 'gildong');
  assert.equal(romanize('석'), 'seok');
  assert.equal(romanize('혁'), 'hyeok');
  assert.equal(romanize('결'), 'gyeol');
  assert.equal(romanize('은'), 'eun');
  assert.equal(romanize('최'), 'choe'); // 표기법 그대로 (성은 관용 표기를 따로 씀)
  assert.equal(romanize('A1'), 'A1');
});

test('성은 관용 표기, 복성은 3글자 이상일 때만', () => {
  assert.equal(romanizeSurname('김'), 'kim');
  assert.equal(romanizeSurname('이'), 'lee');
  assert.equal(romanizeSurname('최'), 'choi');
  assert.equal(romanizeSurname('탁'), 'tak'); // 표에 없으면 표기법
  assert.deepEqual(splitKoreanName('남궁민수'), { surname: '남궁', givenName: '민수' });
  assert.deepEqual(splitKoreanName('남궁'), { surname: '남', givenName: '궁' });
  assert.deepEqual(splitKoreanName(' 홍길동 '), { surname: '홍', givenName: '길동' });
});

test('계정명 기본형: 이름 머리글자 + 성 (홍길동 → gdhong)', () => {
  assert.equal(baseSamFor({ surname: '홍', givenName: '길동' }), 'gdhong');
  assert.equal(baseSamFor({ surname: '강', givenName: '소연' }), 'sykang');
  assert.equal(baseSamFor({ surname: '최', givenName: '은채' }), 'ecchoi'); // ㅊ 머리글자 = c
  assert.equal(baseSamFor({ surname: '남궁', givenName: '민' }), 'mnamgung');
  // 영문(여권 표기) 직접 입력이 우선
  assert.equal(baseSamFor({ surname: '홍', givenName: '길동', surnameEn: 'Hong', givenNameEn: 'Gil-Dong' }), 'gdhong');
  assert.equal(baseSamFor({ surname: '이', givenName: '서윤', surnameEn: 'Rhee', givenNameEn: 'Seo Yun' }), 'syrhee');
});

test('중복이면 숫자, 대소문자 무시, 20자 넘으면 앞을 줄인다', () => {
  const taken = new Set(['gdhong', 'gdhong2']);
  assert.equal(uniqueSam('gdhong', taken), 'gdhong3');
  assert.equal(uniqueSam('GDHong', new Set(['gdhong'])), 'gdhong2');
  const long = 'abcdefghijklmnopqrstuvwxyz';
  const one = uniqueSam(long, new Set());
  assert.equal(one.length, SAM_MAX);
  const two = uniqueSam(long, new Set([one]));
  assert.equal(two.length, SAM_MAX);
  assert.ok(two.endsWith('2'));
});

test('sAMAccountName 검증: 20자, 금지 문자, 제어 문자, 점', () => {
  assert.equal(samProblem('gdhong'), null);
  assert.ok(samProblem('a'.repeat(21)));
  for (const bad of ['a"b', 'a/b', 'a\\b', 'a[b', 'a:b', 'a;b', 'a|b', 'a=b', 'a,b', 'a+b', 'a*b', 'a?b', 'a<b', 'a@b', 'a\nb', '...', 'abc.', '']) {
    assert.ok(samProblem(bad), JSON.stringify(bad));
  }
});

test('일반 입력 검증: 줄바꿈 금지', () => {
  assert.equal(textProblem('홍길동', { label: '이름' }), null);
  assert.ok(textProblem('홍\n길동', { label: '이름' }));
  assert.ok(textProblem('  ', { label: '이름' }));
  assert.equal(textProblem('', { label: '직급', required: false }), null);
});

test('DN 이스케이프 (RFC 4514)', () => {
  assert.equal(escapeDnValue('Kim, Jr.'), 'Kim\\, Jr.');
  assert.equal(escapeDnValue('a+b"c\\d<e>f;g=h'), 'a\\+b\\"c\\\\d\\<e\\>f\\;g\\=h');
  assert.equal(escapeDnValue('#hash'), '\\#hash');
  assert.equal(escapeDnValue(' lead'), '\\ lead');
  assert.equal(escapeDnValue('trail '), 'trail\\ ');
  assert.equal(escapeDnValue('홍길동'), '홍길동');
});

test('DN·UPN 조립과 OU 트리', () => {
  assert.equal(ouDn('SALES'), 'OU=영업팀,OU=본사,OU=부서별 사용자,DC=corp,DC=ossan,DC=example');
  assert.equal(ouDn('PROD'), 'OU=생산팀,OU=제1공장,OU=부서별 사용자,DC=corp,DC=ossan,DC=example');
  assert.equal(ouDn('FORMER'), 'OU=퇴사자,DC=corp,DC=ossan,DC=example');
  assert.equal(userDn('Kim, Jr.', 'SERVICE'), 'CN=Kim\\, Jr.,OU=서비스 계정,DC=corp,DC=ossan,DC=example');
  assert.equal(upnOf('gdhong'), 'gdhong@corp.ossan.example');
  assert.equal(OUS.filter((o) => o.kind === 'DEPT').length, 9);
  assert.equal(GROUPS.length, 15);
  assert.equal(groupDn('GG-ERP-Users'), 'CN=GG-ERP-Users,OU=보안 그룹,DC=corp,DC=ossan,DC=example');
  for (const g of GROUPS) assert.equal(samProblem(g.sam), null, g.sam);
});
