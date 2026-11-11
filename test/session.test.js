import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE,
  isValidPersona,
  isValidTokenFormat,
  computeExpiry,
  isSessionExpired,
  buildSessionCookie,
  buildClearCookie,
  parseCookies,
} from '../src/lib/session.js';
import { randomTokenHex, sha256Hex, constantTimeEqual } from '../src/lib/crypto-util.js';

test('허용된 페르소나만 통과한다', () => {
  assert.equal(isValidPersona('it_admin'), true);
  assert.equal(isValidPersona('employee'), true);
  assert.equal(isValidPersona('domain_admin'), false);
  assert.equal(isValidPersona('__proto__'), false);
  assert.equal(isValidPersona('toString'), false);
  assert.equal(isValidPersona(undefined), false);
  assert.equal(isValidPersona(123), false);
});

test('만료 판정: 지나면 만료, 해석 불가면 만료로 본다', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  const exp = computeExpiry(now, 60);
  assert.equal(exp, '2026-11-11T00:01:00.000Z');
  assert.equal(isSessionExpired(exp, now), false);
  assert.equal(isSessionExpired(exp, new Date('2026-11-11T00:01:00Z')), true);
  assert.equal(isSessionExpired('엉뚱한 값', now), true);
});

test('세션 쿠키에 보안 속성이 모두 붙는다', () => {
  const token = randomTokenHex();
  const cookie = buildSessionCookie(token);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=${token};`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) {
    assert.ok(cookie.includes(attr), attr);
  }
  assert.ok(buildClearCookie().includes('Max-Age=0'));
});

test('형식이 틀린 토큰으로는 쿠키를 만들지 않는다 (쿠키 헤더 주입 방지)', () => {
  assert.throws(() => buildSessionCookie('abc; Domain=evil.example'));
  assert.equal(isValidTokenFormat(randomTokenHex()), true);
  assert.equal(isValidTokenFormat('A'.repeat(64)), false);
});

test('Cookie 헤더 해석', () => {
  assert.deepEqual(parseCookies('a=1; ops_session=xyz; b=2'), { a: '1', ops_session: 'xyz', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; a=2'), { a: '1' });
});

test('토큰 해시와 일정 시간 비교', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(await constantTimeEqual('secret-token', 'secret-token'), true);
  assert.equal(await constantTimeEqual('secret-token', 'secret-tokeN'), false);
  assert.equal(await constantTimeEqual('short', 'much-longer-value'), false);
  assert.equal(await constantTimeEqual(undefined, 'x'), false);
});
