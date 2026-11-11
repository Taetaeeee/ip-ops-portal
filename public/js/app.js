// 로그인 후 홈: 환영 배너, 회사 개요(실제 데이터), 빠른 작업
// 숫자는 모두 서버가 준 실제 값이다 (장식용 가짜 지표를 만들지 않는다).

import { api, el, $, icon, initShell, showError, formatKst } from './common.js';

// 빠른 작업: 실제로 있는 화면으로 이동하는 버튼만
const QUICK = [
  { href: '/ticket-new', label: '요청 등록', icon: 'plus' },
  { href: '/tickets', label: '헬프데스크', icon: 'list' },
  { href: '/faq', label: 'FAQ 찾아보기', icon: 'help' },
  { href: '/assets', label: '자산 조회', icon: 'monitor', itOnly: true },
  { href: '/licenses', label: '라이선스 현황', icon: 'key', itOnly: true },
  { href: '/directory', label: '계정 관리', icon: 'sitemap', itOnly: true },
  { href: '/lifecycle', label: '입·퇴사 처리', icon: 'users', itOnly: true },
];

function kpi(label, value, unit, iconName, tone = '') {
  return el(
    'div',
    { class: 'kpi' },
    el('span', { class: `kpi-icon ${tone}` }, icon(iconName)),
    el('div', {}, el('div', { class: 'kpi-label', text: label }), el('div', { class: 'kpi-value' }, String(value), el('small', { text: unit }))),
  );
}

function render(me, summary) {
  const e = me.employee;
  $('greeting').textContent = `안녕하세요, ${e.name} ${e.jobTitle}님`;
  $('hero-sub').textContent =
    me.persona === 'it_admin'
      ? '헬프데스크, IT 자산·라이선스, 계정, 입·퇴사 업무를 한곳에서 처리할 수 있습니다.'
      : 'PC·계정·프린터 문제가 생기면 먼저 FAQ 를 찾아보고, 해결되지 않으면 요청을 등록해 주세요.';

  const site = (kind) => summary.sites.find((s) => s.kind === kind);
  const hq = site('HQ');
  const plant = site('PLANT');
  $('kpis').replaceChildren(
    kpi('재직 인원', summary.totalHeadcount, '명', 'users'),
    kpi(hq?.name ?? '본사', hq?.headcount ?? 0, '명', 'building'),
    kpi(plant?.name ?? '공장', plant?.headcount ?? 0, '명', 'factory'),
    kpi('입사 예정', summary.upcomingHires ?? 0, '명', 'user-plus', 'ok'),
    kpi('퇴사', summary.resigned ?? 0, '명', 'user-minus', 'neutral'),
  );

  $('company-line').textContent = summary.company.business;
  $('sites').replaceChildren(
    ...summary.sites.map((s) =>
      el(
        'div',
        { class: 'site-card' },
        el('h4', {}, icon(s.kind === 'HQ' ? 'building' : 'factory'), `${s.name} · ${s.headcount}명`),
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', { text: '부서' }), el('th', { class: 'num', text: '인원' }))),
          el('tbody', {}, s.departments.map((d) => el('tr', {}, el('td', { text: d.name }), el('td', { class: 'num', text: `${d.headcount}명` })))),
        ),
      ),
    ),
  );
  $('last-reset').textContent = summary.lastReset
    ? `마지막 데모 초기화: ${formatKst(summary.lastReset.finishedAt)} (${summary.lastReset.trigger === 'cron' ? '자동' : '수동'})`
    : '데모 초기화 기록이 없습니다.';

  const isIt = me.persona === 'it_admin';
  $('quick').replaceChildren(
    ...QUICK.filter((q) => !q.itOnly || isIt).map((q) => el('a', { class: 'quick', href: q.href }, icon(q.icon), el('span', { text: q.label }))),
  );
}

try {
  const me = await initShell('home');
  render(me, await api('/api/org/summary'));
} catch (err) {
  if (err.status !== 401) showError('app-error', err);
}
