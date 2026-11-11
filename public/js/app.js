// 로그인 후 홈 화면: 회사 개요

import { api, el, $, initShell, showError, formatKst } from './common.js';

function renderSummary(summary) {
  const c = summary.company;
  const extra = [
    summary.upcomingHires ? `입사 예정 ${summary.upcomingHires}명` : null,
    summary.resigned ? `퇴사 ${summary.resigned}명` : null,
  ].filter(Boolean);
  $('company-line').textContent = `${c.business} · 재직 ${summary.totalHeadcount}명${extra.length ? ` (${extra.join(', ')} 제외)` : ''}`;

  $('sites').replaceChildren(
    ...summary.sites.map((site) =>
      el(
        'article',
        { class: 'card' },
        el('h3', { text: `${site.name} · ${site.headcount}명` }),
        el(
          'table',
          {},
          el('tr', {}, el('th', { text: '부서' }), el('th', { text: '인원' })),
          site.departments.map((d) => el('tr', {}, el('td', { text: d.name }), el('td', { class: 'num', text: `${d.headcount}명` }))),
        ),
      ),
    ),
  );

  $('last-reset').textContent = summary.lastReset
    ? `마지막 데모 초기화: ${formatKst(summary.lastReset.finishedAt)} (${summary.lastReset.trigger === 'cron' ? '자동' : '수동'})`
    : '데모 초기화 기록이 없습니다.';
}

try {
  await initShell('home');
  renderSummary(await api('/api/org/summary'));
} catch (err) {
  if (err.status !== 401) showError('app-error', err);
}
