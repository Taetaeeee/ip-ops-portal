import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIncidentLink } from '../src/lib/link-rules.js';

const BASE = 'https://status-monitor.nalzzoaleph26.workers.dev/';

test('B 주소의 https 링크는 저장된다', () => {
  const r = validateIncidentLink(' https://status-monitor.nalzzoaleph26.workers.dev/incidents/3 ', BASE);
  assert.deepEqual(r, { ok: true, value: 'https://status-monitor.nalzzoaleph26.workers.dev/incidents/3' });
});

test('빈 값은 링크 삭제', () => {
  assert.deepEqual(validateIncidentLink('', BASE), { ok: true, value: null });
  assert.deepEqual(validateIncidentLink(null, BASE), { ok: true, value: null });
});

test('거부: 다른 사이트, http, javascript:, 계정 정보, 형식 오류, 비슷한 도메인', () => {
  const bad = [
    'https://evil.example/incidents/3',
    'http://status-monitor.nalzzoaleph26.workers.dev/incidents/3',
    'javascript:alert(1)',
    'https://user:pw@status-monitor.nalzzoaleph26.workers.dev/x',
    'not a url',
    'https://status-monitor.nalzzoaleph26.workers.dev.evil.example/x',
    `https://status-monitor.nalzzoaleph26.workers.dev/${'a'.repeat(600)}`,
    123,
  ];
  for (const v of bad) assert.equal(validateIncidentLink(v, BASE).ok, false, String(v).slice(0, 60));
});

test('B 주소 설정이 없으면 거부', () => {
  assert.equal(validateIncidentLink('https://x.example/', undefined).ok, false);
});
