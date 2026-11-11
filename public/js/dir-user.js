// 가상 AD 계정 상세: 속성, 소속 그룹, 이벤트, 작업 실행, 로그인 시험 (IT 담당자 전용)

import { api, el, $, initShell, showError, hideError, formatKst } from './common.js';
import { accountBadges } from './dir-common.js';

const id = Number(new URLSearchParams(location.search).get('id'));
let meta;
let detail;

const SIMPLE_OPS = ['DISABLE_ACCOUNT', 'ENABLE_ACCOUNT', 'RESET_PASSWORD', 'UNLOCK_ACCOUNT'];
const OP_CONFIRM = {
  DISABLE_ACCOUNT: '계정을 비활성화합니다. 이 사용자는 로그인할 수 없게 됩니다.',
  RESET_PASSWORD: '비밀번호를 초기화합니다. 다음 로그인 때 변경해야 합니다.',
};

function attrRows(u) {
  const t = (v) => (v ? formatKst(v) : null);
  return [
    ['sAMAccountName', u.sam],
    ['userPrincipalName', u.upn],
    ['distinguishedName', u.dn],
    ['소속 OU', u.ouPath],
    ['Enabled', String(u.enabled)],
    ['LockedOut', u.lockedOut ? `true (${t(u.lockoutTime)} 잠김)` : 'false'],
    ['badPwdCount', String(u.badPwdCount)],
    ['pwdLastSet', u.pwdLastSet ? t(u.pwdLastSet) : '0 (다음 로그온 시 변경 필요)'],
    ['lastLogon', t(u.lastLogon) ?? '로그온 기록 없음'],
    ['whenCreated', t(u.whenCreated)],
    ['displayName', u.displayName],
    ['givenName / sn', u.givenName || u.surname ? `${u.givenName ?? ''} / ${u.surname ?? ''}` : null],
    ['employeeID', u.employeeId],
    ['department', u.department],
    ['title', u.title],
    ['description', u.description],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
}

function render() {
  const u = detail.user;
  document.title = `${u.sam} · 도담테크산업 IT 운영 포털 (시뮬레이션)`;
  $('title').replaceChildren(el('span', { class: 'mono', text: u.sam }), ` ${u.displayName}`);
  $('badges').replaceChildren(accountBadges(u));
  $('back').href = `/directory?ou=${u.ouKey}`;

  $('attrs').replaceChildren(...attrRows(u).flatMap(([k, v]) => [el('dt', { class: 'mono', text: k }), el('dd', { class: 'break', text: v })]));

  $('groups').replaceChildren(
    ...(detail.memberOf.length
      ? detail.memberOf.map((g) =>
          el('li', {}, el('span', { class: 'mono', text: g.sam }), el('span', { class: 'muted small', text: ` — ${g.description ?? ''}` })),
        )
      : [el('li', { class: 'muted', text: '소속 그룹 없음' })]),
  );

  $('events').replaceChildren(
    el('thead', {}, el('tr', {}, ['시각', 'ID', '내용', '작업자', ''].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      detail.events.length
        ? detail.events.map((e) =>
            el(
              'tr',
              {},
              el('td', { class: 'small nowrap', text: formatKst(e.occurredAt) }),
              el('td', {}, el('span', { class: `badge ev-${e.eventId}`, text: String(e.eventId) })),
              el('td', { text: `${e.eventName}${e.groupSam ? ` (${e.groupSam})` : ''}${e.details?.status ? ` · ${e.details.status} ${e.details.reason ?? ''}` : ''}` }),
              el('td', { class: 'mono small', text: e.actorSam }),
              el('td', {}, e.operationId ? el('a', { href: `/dir-result?id=${e.operationId}`, class: 'small', text: '작업 보기' }) : ''),
            ),
          )
        : el('tr', {}, el('td', { colspan: 5, class: 'muted', text: '이벤트 없음' })),
    ),
  );

  $('operations').replaceChildren(
    ...(detail.operations.length
      ? detail.operations.map((o) =>
          el('li', {}, el('a', { href: `/dir-result?id=${o.id}`, text: `${o.label}` }), el('span', { class: 'muted small', text: ` · ${o.actorSam} · ${formatKst(o.createdAt)}` })),
        )
      : [el('li', { class: 'muted', text: '이 포털에서 실행한 작업 없음' })]),
  );

  // 작업 버튼: 지금 가능한 것만
  $('simple-ops').replaceChildren(
    ...SIMPLE_OPS.filter((t) => detail.availableOperations.includes(t)).map((t) =>
      el('button', { type: 'button', class: `button${t === 'DISABLE_ACCOUNT' ? ' danger' : ''}`, dataset: { op: t }, text: meta.operations[t] }),
    ),
  );

  const addSel = $('add-group-form').group;
  addSel.replaceChildren(...detail.addableGroups.map((g) => el('option', { value: g, text: g })));
  $('add-group-card').hidden = detail.addableGroups.length === 0;
  const rmSel = $('remove-group-form').group;
  rmSel.replaceChildren(...detail.memberOf.map((g) => el('option', { value: g.sam, text: g.sam })));
  $('remove-group-card').hidden = detail.memberOf.length === 0;
  $('move-form').ouKey.replaceChildren(...detail.moveTargets.map((o) => el('option', { value: o.key, text: o.path })));

  $('account').hidden = false;
}

async function runOperation(body, button) {
  hideError('action-error');
  if (button) button.disabled = true;
  try {
    const r = await api('/api/directory/operations', { method: 'POST', body: { ...body, userId: id } });
    location.assign(`/dir-result?id=${r.operation.id}`);
  } catch (err) {
    showError('action-error', err);
    if (button) button.disabled = false;
  }
}

function wire() {
  // 되돌리기 번거로운 작업은 화면 안에서 한 번 더 확인한다 (브라우저 confirm 창 대신)
  $('simple-ops').addEventListener('click', (e) => {
    const confirmBtn = e.target.closest('button[data-confirm-op]');
    if (confirmBtn) {
      runOperation({ type: confirmBtn.dataset.confirmOp }, confirmBtn);
      return;
    }
    if (e.target.closest('button[data-cancel]')) {
      $('simple-ops').querySelector('.op-confirm')?.remove();
      return;
    }
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const msg = OP_CONFIRM[b.dataset.op];
    if (!msg) {
      runOperation({ type: b.dataset.op }, b);
      return;
    }
    $('simple-ops').querySelector('.op-confirm')?.remove();
    $('simple-ops').append(
      el(
        'div',
        { class: 'op-confirm', role: 'alert' },
        el('p', { text: `${msg} 가상 디렉터리에만 반영되고, 스크립트는 미실행으로 만들어집니다.` }),
        el('button', { type: 'button', class: 'button danger', dataset: { confirmOp: b.dataset.op }, text: `${meta.operations[b.dataset.op]} 실행` }),
        el('button', { type: 'button', class: 'button', dataset: { cancel: '1' }, text: '취소' }),
      ),
    );
  });
  $('add-group-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runOperation({ type: 'ADD_GROUP_MEMBER', group: e.target.group.value }, e.submitter);
  });
  $('remove-group-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runOperation({ type: 'REMOVE_GROUP_MEMBER', group: e.target.group.value }, e.submitter);
  });
  $('move-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runOperation({ type: 'MOVE_OU', ouKey: e.target.ouKey.value }, e.submitter);
  });
  for (const b of document.querySelectorAll('[data-logon]')) {
    b.addEventListener('click', async () => {
      hideError('action-error');
      try {
        const r = await api(`/api/directory/users/${id}/logon-test`, { method: 'POST', body: { passwordCorrect: b.dataset.logon === 'true' } });
        detail = r.detail;
        render();
        const box = $('logon-result');
        box.className = `logon-result ${r.success ? 'ok' : 'fail'}`;
        box.replaceChildren(
          el('strong', { text: r.success ? '성공' : '실패' }),
          ` ${r.reason}`,
          r.status ? el('span', { class: 'mono small', text: ` (${r.status})` }) : '',
          el('div', { class: 'small', text: `기록된 이벤트: ${r.events.map((e) => `${e.eventId} ${e.eventName}`).join(', ')}` }),
        );
        box.hidden = false;
      } catch (err) {
        showError('action-error', err);
      }
    });
  }
}

try {
  const me = await initShell('directory');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('잘못된 계정 번호입니다');
  [meta, detail] = await Promise.all([api('/api/directory/meta'), api(`/api/directory/users/${id}`)]);
  $('lockout-policy').textContent = `계정 잠금 정책: 비밀번호 ${meta.lockoutPolicy.threshold}회 실패 시 잠김, 관리자가 해제할 때까지 유지`;
  wire();
  render();
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
