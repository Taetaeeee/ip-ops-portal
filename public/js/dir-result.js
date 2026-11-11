// 계정 작업 결과: (1) 디렉터리 변경 (2) 생성된 스크립트(미실행) (3) 기록된 이벤트

import { api, el, $, initShell, showError, formatKst } from './common.js';
import { accountBadges } from './dir-common.js';

const id = Number(new URLSearchParams(location.search).get('id'));

const show = (v) => (v === true ? 'true' : v === false ? 'false' : v === '' || v === null || v === undefined ? '(없음)' : String(v));

function render({ operation: op, events, user }) {
  document.title = `${op.label} 결과 · 도담테크산업 IT 운영 포털 (시뮬레이션)`;
  $('title').replaceChildren(`${op.label} — `, el('span', { class: 'mono', text: op.targetSam }));
  $('subtitle').textContent = `작업 #${op.id} · 작업자 ${op.actorSam} · ${formatKst(op.createdAt)}`;
  if (op.targetUserId) $('back').href = `/dir-user?id=${op.targetUserId}`;

  $('diff').replaceChildren(
    el('thead', {}, el('tr', {}, ['속성', '변경 전', '변경 후'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      op.diff.map((d) =>
        el('tr', {}, el('td', { class: 'mono', text: d.field }), el('td', { class: 'break before', text: show(d.before) }), el('td', { class: 'break after', text: show(d.after) })),
      ),
    ),
  );
  $('now-state').replaceChildren(
    ...(user ? ['현재 디렉터리 상태: ', el('a', { href: `/dir-user?id=${user.id}`, class: 'mono', text: user.sam }), ' ', accountBadges(user), el('div', { class: 'muted break', text: user.dn })] : []),
  );
  $('notes').replaceChildren(...op.notes.map((n) => el('li', { text: n })));

  $('script').textContent = op.script; // textContent: 스크립트 내용이 HTML 로 해석되지 않는다

  $('events').replaceChildren(
    el('thead', {}, el('tr', {}, ['ID', '내용', '대상', '그룹', '작업자', '시각'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      events.map((e) =>
        el(
          'tr',
          {},
          el('td', {}, el('span', { class: `badge ev-${e.eventId}`, text: String(e.eventId) })),
          el('td', { text: e.eventName }),
          el('td', { class: 'mono', text: e.targetSam }),
          el('td', { class: 'mono', text: e.groupSam ?? '-' }),
          el('td', { class: 'mono', text: e.actorSam }),
          el('td', { class: 'small nowrap', text: formatKst(e.occurredAt) }),
        ),
      ),
    ),
  );
  $('result').hidden = false;
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('script').textContent);
    $('copy').textContent = '복사됨';
  } catch {
    $('copy').textContent = '복사 실패 (직접 선택하세요)';
  }
});

try {
  const me = await initShell('directory');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('잘못된 작업 번호입니다');
  render(await api(`/api/directory/operations/${id}`));
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
