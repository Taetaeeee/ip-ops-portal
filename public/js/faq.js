// FAQ 목록: 분류·검색은 화면에서 거른다 (FAQ 수가 적으므로)

import { api, el, $, initShell, loadMeta, showError } from './common.js';

let meta;
let faqs = [];

function render() {
  const q = $('faq-search').value.trim().toLowerCase();
  const category = $('faq-category').value;
  const shown = faqs.filter(
    (f) =>
      (!category || f.category === category) &&
      (!q || `${f.title} ${f.question} ${f.answer}`.toLowerCase().includes(q)),
  );
  $('faq-count').textContent = `${shown.length}건`;
  const openId = location.hash.replace('#faq-', '');

  $('faq-list').replaceChildren(
    ...shown.map((f) =>
      el(
        'details',
        { class: 'card faq', id: `faq-${f.id}`, open: String(f.id) === openId },
        el('summary', {}, el('span', { class: 'badge', text: meta.categories[f.category] ?? f.category }), ` ${f.title}`),
        el('h4', { text: '질문' }),
        el('p', { class: 'pre', text: f.question }),
        el('h4', { text: '답변' }),
        el('p', { class: 'pre', text: f.answer }),
        f.sourceTicket
          ? el('p', { class: 'muted small' }, '원본 요청: ', el('a', { href: `/ticket?id=${f.sourceTicket.id}`, text: f.sourceTicket.ticketNo }))
          : null,
      ),
    ),
  );
}

try {
  await initShell('faq');
  meta = await loadMeta();
  $('faq-category').replaceChildren(
    el('option', { value: '', text: '전체' }),
    ...Object.entries(meta.categories).map(([v, label]) => el('option', { value: v, text: label })),
  );
  faqs = (await api('/api/faq')).faqs;
  $('faq-search').addEventListener('input', render);
  $('faq-category').addEventListener('change', render);
  render();
} catch (err) {
  if (err.status !== 401) showError('faq-error', err);
}
