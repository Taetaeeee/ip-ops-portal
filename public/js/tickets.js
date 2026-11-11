// 티켓 목록: 직원은 "내 요청", IT 담당자는 전체 + 필터·검색
// 필터는 주소(?status=...)에 남겨, 새로고침·뒤로 가기에도 유지된다.

import { api, el, $, initShell, loadMeta, showError, formatKst, slaBadge, statusBadge, priorityBadge } from './common.js';

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, text: label })));
  select.value = value ?? '';
}

function setupFilters(meta, params) {
  const form = $('filters');
  form.hidden = false;
  const entries = (obj) => Object.entries(obj);
  fillSelect(form.status, [['', '전체'], ['OPEN', '미완료'], ...entries(meta.statuses)], params.get('status'));
  fillSelect(form.category, [['', '전체'], ...entries(meta.categories)], params.get('category'));
  fillSelect(form.priority, [['', '전체'], ...entries(meta.priorities)], params.get('priority'));
  fillSelect(
    form.assignee,
    [['', '전체'], ['NONE', '미배정'], ...meta.assignees.map((a) => [a.empNo, `${a.name} ${a.jobTitle}`])],
    params.get('assignee'),
  );
  fillSelect(form.sla, [['', '전체'], ['OVERDUE', '초과'], ['IMMINENT', '임박']], params.get('sla'));
  form.q.value = params.get('q') ?? '';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (String(v).trim()) next.set(k, String(v).trim());
    // 상태를 '전체'로 고르면 기본값(미완료)과 구분하려고 status=ALL 로 남긴다
    if (!next.has('status')) next.set('status', 'ALL');
    location.search = next.toString();
  });
}

function renderTable(tickets, meta, isItStaff) {
  const head = el(
    'tr',
    {},
    ['번호', '제목', '분류', '긴급도', '상태', isItStaff ? '요청자' : null, '담당자', '접수', 'SLA']
      .filter(Boolean)
      .map((h) => el('th', { scope: 'col', text: h })),
  );
  const rows = tickets.map((t) =>
    el(
      'tr',
      {},
      el('td', { class: 'nowrap' }, el('a', { href: `/ticket?id=${t.id}`, text: t.ticketNo })),
      el('td', {}, el('a', { href: `/ticket?id=${t.id}`, text: t.title })),
      el('td', { text: meta.categories[t.category] }),
      el('td', {}, priorityBadge(t.priority, meta)),
      el('td', {}, statusBadge(t.status, meta)),
      isItStaff ? el('td', { text: `${t.requester.name} (${t.requester.department})` }) : null,
      el('td', { text: t.assignee?.name ?? '미배정' }),
      el('td', { class: 'nowrap small', text: formatKst(t.createdAt) }),
      el('td', {}, slaBadge(t.sla, meta)),
    ),
  );
  $('ticket-table').replaceChildren(el('thead', {}, head), el('tbody', {}, rows));
}

try {
  await initShell('tickets');
  const meta = await loadMeta();
  const isItStaff = meta.viewer.isItStaff;
  const params = new URLSearchParams(location.search);

  // IT 담당자 기본 화면은 "미완료"
  if (isItStaff && !params.has('status')) params.set('status', 'OPEN');
  const query = new URLSearchParams(params);
  if (query.get('status') === 'ALL') query.delete('status');

  $('page-title').textContent = isItStaff ? '헬프데스크 · 전체 요청' : '헬프데스크 · 내 요청';
  if (isItStaff) setupFilters(meta, params);

  const h = meta.sla.businessHours;
  $('sla-note').textContent =
    `SLA는 업무 시간(평일 ${h.start}~${h.end}시) 기준입니다. 보류 중에는 시계가 멈춥니다. ` +
    `임박 = 남은 시간이 목표의 ${Math.round(meta.sla.imminentRatio * 100)}% 이하.`;

  const data = await api(`/api/tickets?${query}`);
  $('count').textContent = `${data.count}건`;
  renderTable(data.tickets, meta, isItStaff);
} catch (err) {
  if (err.status !== 401) showError('list-error', err);
}
