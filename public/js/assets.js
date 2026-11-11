// IT 자산 목록 (IT 담당자 전용). 필터는 주소에 남긴다.

import { api, el, $, initShell, showError } from './common.js';

let meta;
const loadAssetMeta = () => api('/api/assets/meta');

export function assetStatusBadge(status, m) {
  return el('span', { class: `badge asset-${status.toLowerCase()}`, text: m.statuses[status] ?? status });
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, text: label })));
  select.value = value ?? '';
}

try {
  const me = await initShell('assets');
  if (me.persona !== 'it_admin') throw Object.assign(new Error('IT 담당자만 볼 수 있는 화면입니다'), { status: 403 });
  meta = await loadAssetMeta();

  const params = new URLSearchParams(location.search);
  if (!params.has('status')) params.set('status', 'ACTIVE'); // 기본: 폐기 제외
  const form = $('filters');
  fillSelect(form.type, [['', '전체'], ...Object.entries(meta.types)], params.get('type'));
  fillSelect(form.status, [['ALL', '전체'], ['ACTIVE', '폐기 제외'], ...Object.entries(meta.statuses)], params.get('status'));
  form.q.value = params.get('q') ?? '';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (String(v).trim()) next.set(k, String(v).trim());
    location.search = next.toString();
  });

  const query = new URLSearchParams(params);
  if (query.get('status') === 'ALL') query.delete('status');
  const data = await api(`/api/assets?${query}`);
  $('count').textContent = `${data.count}개`;

  $('asset-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['자산 번호', '종류', '제조사 · 모델', '상태', '사용자 / 위치', '구매일'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      data.assets.map((a) =>
        el(
          'tr',
          {},
          el('td', { class: 'nowrap' }, el('a', { href: `/asset?id=${a.id}`, text: a.assetTag })),
          el('td', { text: meta.types[a.assetType] }),
          el('td', { text: `${a.manufacturer} ${a.model}` }),
          el('td', {}, assetStatusBadge(a.status, meta)),
          el('td', { text: a.holder ? `${a.holder.name} (${a.holder.department})` : a.location ?? '-' }),
          el('td', { class: 'nowrap small', text: a.purchasedOn }),
        ),
      ),
    ),
  );
} catch (err) {
  if (err.status !== 401) showError('list-error', err);
}
