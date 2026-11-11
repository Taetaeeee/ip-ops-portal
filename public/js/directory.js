// 가상 AD 디렉터리: OU 트리 / 사용자 목록 / 계정 생성 (IT 담당자 전용)

import { api, el, $, initShell, showError, hideError, formatKst } from './common.js';
import { accountBadges } from './dir-common.js';

const params = new URLSearchParams(location.search);
const currentOu = params.get('ou') || 'USERS';
let meta;

function renderTree(tree) {
  const children = (parent) => tree.ous.filter((o) => o.parent === parent);
  const node = (o) => {
    const c = o.counts;
    const countText = o.key === 'GROUPS' ? `${c.groups}` : `${c.total}`;
    const warn = o.key !== 'GROUPS' && (c.locked || c.disabled) ? ` · 잠김 ${c.locked} · 비활성 ${c.disabled}` : '';
    const link =
      o.key === 'GROUPS'
        ? el('span', { class: 'tree-label', title: o.dn }, o.name, el('span', { class: 'muted small', text: ` (${countText})` }))
        : el(
            'a',
            { href: `/directory?ou=${o.key}`, class: 'tree-label', title: o.dn, 'aria-current': o.key === currentOu ? 'page' : null },
            o.name,
            el('span', { class: 'muted small', text: ` (${countText}${warn})` }),
          );
    const kids = children(o.key);
    return el('li', {}, link, kids.length ? el('ul', {}, kids.map(node)) : null);
  };
  $('tree').replaceChildren(el('li', {}, el('strong', { text: tree.domain.dns }), el('ul', {}, children(null).map(node))));
}

function renderUsers(data) {
  const ou = meta.ous.find((o) => o.key === currentOu);
  $('list-title').textContent = `${ou.path} — ${data.count}개 계정`;
  $('user-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['sAMAccountName', '이름', '직급', 'OU', '상태', 'lastLogon'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      data.users.map((u) =>
        el(
          'tr',
          {},
          el('td', { class: 'nowrap mono' }, el('a', { href: `/dir-user?id=${u.id}`, text: u.sam })),
          el('td', { text: u.displayName }),
          el('td', { text: u.title ?? '-' }),
          el('td', { class: 'small', text: u.ouPath.split(' › ').at(-1) }),
          el('td', {}, accountBadges(u)),
          el('td', { class: 'small nowrap', text: u.lastLogon ? formatKst(u.lastLogon) : '-' }),
        ),
      ),
    ),
  );
}

function setupCreate() {
  const form = $('create-form');
  form.ouKey.replaceChildren(
    el('option', { value: '', text: '선택하세요' }),
    ...meta.ous.filter((o) => o.kind === 'DEPT').map((o) => el('option', { value: o.key, text: o.path })),
  );
  $('toggle-create').addEventListener('click', () => {
    $('create-card').hidden = !$('create-card').hidden;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('create-error');
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const fd = new FormData(form);
    const body = { type: 'CREATE_USER' };
    for (const k of ['displayName', 'ouKey', 'title', 'employeeId', 'surnameEn', 'givenNameEn', 'sam']) {
      const v = String(fd.get(k) ?? '').trim();
      if (v) body[k] = v;
    }
    try {
      const r = await api('/api/directory/operations', { method: 'POST', body });
      location.assign(`/dir-result?id=${r.operation.id}`);
    } catch (err) {
      showError('create-error', err);
      button.disabled = false;
    }
  });
}

try {
  const me = await initShell('directory');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  [meta] = await Promise.all([api('/api/directory/meta')]);
  $('domain').textContent = `${meta.domain.dns} (${meta.domain.netbios})`;
  setupCreate();

  const form = $('filters');
  form.state.value = params.get('state') ?? '';
  form.q.value = params.get('q') ?? '';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = new URLSearchParams({ ou: currentOu });
    for (const [k, v] of new FormData(form)) if (String(v).trim()) next.set(k, String(v).trim());
    location.search = next.toString();
  });

  const query = new URLSearchParams({ ou: currentOu });
  for (const k of ['state', 'q']) if (params.get(k)) query.set(k, params.get(k));
  const [tree, users] = await Promise.all([api('/api/directory/tree'), api(`/api/directory/users?${query}`)]);
  renderTree(tree);
  renderUsers(users);
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
