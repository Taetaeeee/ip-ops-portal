// 새 요청 접수

import { api, el, $, initShell, loadMeta, showError, hideError, formatMinutes } from './common.js';

const PRIORITY_HINTS = {
  URGENT: '업무가 멈춤 (생산·출하 중단, 보안 사고)',
  HIGH: '업무에 큰 지장 (혼자 일을 못 함)',
  NORMAL: '불편하지만 우회 가능',
  LOW: '요청·문의 (설치, 설정 변경 등)',
};

try {
  await initShell('tickets');
  const meta = await loadMeta();
  const form = $('new-ticket');

  form.category.replaceChildren(
    el('option', { value: '', text: '선택하세요' }),
    ...Object.entries(meta.categories).map(([v, label]) => el('option', { value: v, text: label })),
  );

  $('priorities').replaceChildren(
    ...Object.entries(meta.priorities).map(([v, label]) =>
      el(
        'label',
        { class: 'radio' },
        el('input', { type: 'radio', name: 'priority', value: v, checked: v === 'NORMAL' }),
        el('span', {}, el('strong', { text: label }), ` — ${PRIORITY_HINTS[v]} · 목표 ${formatMinutes(meta.sla.targetMinutes[v])}(업무 시간)`),
      ),
    ),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError('form-error');
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const fd = new FormData(form);
      const res = await api('/api/tickets', {
        method: 'POST',
        body: {
          category: fd.get('category'),
          priority: fd.get('priority'),
          title: fd.get('title'),
          symptom: fd.get('symptom'),
        },
      });
      location.assign(`/ticket?id=${res.id}`);
    } catch (err) {
      showError('form-error', err);
      button.disabled = false;
    }
  });
} catch (err) {
  if (err.status !== 401) showError('form-error', err);
}
