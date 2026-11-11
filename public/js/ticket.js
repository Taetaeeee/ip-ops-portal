// 요청 상세: 정보, 이력, (IT 담당자) 배정·상태 변경·메모·B 링크·FAQ 등록
// 권한 검사는 서버가 한다. 화면은 IT 담당자에게만 작업 패널을 보여 줄 뿐이다.

import {
  api, el, $, initShell, loadMeta, showError, hideError,
  formatKst, formatMinutes, slaBadge, statusBadge, priorityBadge,
} from './common.js';

const id = Number(new URLSearchParams(location.search).get('id'));
let meta;
let detail;

const nameOf = (empNo) => {
  const a = meta.assignees.find((x) => x.empNo === empNo);
  return a ? a.name : empNo ?? '없음';
};

function dlRows(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v ?? '-')]));
}

function eventText(ev) {
  switch (ev.type) {
    case 'CREATED':
      return '요청 접수';
    case 'ASSIGNED':
      return ev.data?.from ? `담당자 변경: ${nameOf(ev.data.from)} → ${nameOf(ev.data.to)}` : `담당자 지정: ${nameOf(ev.data?.to)}`;
    case 'STATUS_CHANGED':
      return `상태 변경: ${meta.statuses[ev.fromStatus]} → ${meta.statuses[ev.toStatus]}`;
    case 'NOTE':
      return '처리 메모';
    case 'LINK_CHANGED':
      return ev.data?.to ? 'Uptime Monitor 장애 링크 저장' : 'Uptime Monitor 장애 링크 삭제';
    case 'FAQ_PUBLISHED':
      return 'FAQ 등록';
    default:
      return ev.type;
  }
}

function eventDetails(ev) {
  const parts = [];
  if (ev.note) parts.push(el('p', { class: 'pre', text: ev.note }));
  if (ev.type === 'STATUS_CHANGED' && ev.data?.newDueAt && ev.data.pausedMinutesAdded > 0) {
    parts.push(el('p', { class: 'muted small', text: `보류 ${formatMinutes(ev.data.pausedMinutesAdded)} 제외 → 기한 ${formatKst(ev.data.newDueAt)}` }));
  }
  if (ev.type === 'STATUS_CHANGED' && ev.toStatus === 'RESOLVED' && ev.data) {
    parts.push(el('p', { class: 'small', text: `원인: ${ev.data.cause} / 조치: ${ev.data.action} / 검증: ${ev.data.verification}` }));
  }
  if (ev.type === 'LINK_CHANGED' && ev.data?.to) parts.push(el('p', { class: 'small break', text: ev.data.to }));
  return parts;
}

function render() {
  const t = detail.ticket;
  document.title = `${t.ticketNo} · 도담테크산업 IT 운영 포털 (시뮬레이션)`;
  $('title').textContent = `${t.ticketNo} ${t.title}`;
  $('badges').replaceChildren(statusBadge(t.status, meta), priorityBadge(t.priority, meta), slaBadge(t.sla, meta));

  dlRows($('info'), [
    ['분류', meta.categories[t.category]],
    ['요청자', `${t.requester.name} (${t.requester.department})`],
    ['담당자', t.assignee ? t.assignee.name : '미배정'],
    ['접수', formatKst(t.createdAt)],
    ['SLA 기한', `${formatKst(t.sla.dueAt)}${t.sla.pausedMinutes ? ` (보류 ${formatMinutes(t.sla.pausedMinutes)} 제외)` : ''}`],
    t.holdStartedAt ? ['보류 시작', formatKst(t.holdStartedAt)] : null,
    t.resolvedAt ? ['완료', formatKst(t.resolvedAt)] : null,
    t.faqId ? ['FAQ', el('a', { href: `/faq#faq-${t.faqId}`, text: '등록됨' })] : null,
  ].filter(Boolean));
  $('symptom').textContent = t.symptom;

  $('resolution-card').hidden = !t.resolution;
  if (t.resolution) {
    dlRows($('resolution'), [
      ['원인', t.resolution.cause],
      ['조치', t.resolution.action],
      ['검증 결과', t.resolution.verification],
    ]);
  }

  // B 링크: https 로 시작하는 값만 링크로 만든다 (서버도 검증하지만 화면에서도 한 번 더)
  const url = t.incidentUrl;
  $('incident-view').replaceChildren(
    url && url.startsWith('https://')
      ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'break', text: url })
      : el('span', { class: 'muted', text: '연결된 장애 없음' }),
  );

  $('timeline').replaceChildren(
    ...detail.events.map((ev) =>
      el(
        'li',
        {},
        el('div', { class: 'tl-head' }, el('strong', { text: eventText(ev) }), el('span', { class: 'muted small', text: ` · ${ev.actor.name} · ${formatKst(ev.createdAt)}` })),
        ...eventDetails(ev),
      ),
    ),
  );

  if (meta.viewer.isItStaff) renderItPanel(t);
  $('ticket').hidden = false;
}

function renderItPanel(t) {
  $('it-panel').hidden = false;
  const closed = t.status === 'RESOLVED';

  const assign = $('assign-form');
  assign.assigneeEmpNo.replaceChildren(
    ...meta.assignees.map((a) => el('option', { value: a.empNo, text: `${a.name} ${a.jobTitle} (${a.duty})` })),
  );
  assign.assigneeEmpNo.value = t.assignee?.empNo ?? meta.viewer.empNo;
  assign.closest('section').hidden = closed;

  const statusForm = $('status-form');
  const allowed = detail.allowedTransitions;
  $('status-card').hidden = allowed.length === 0;
  statusForm.to.replaceChildren(...allowed.map((s) => el('option', { value: s, text: meta.statuses[s] })));
  statusForm.reset();
  updateStatusFields();

  $('note-card').hidden = closed;

  $('incident-form').hidden = false;
  $('incident-form').url.value = t.incidentUrl ?? '';
  $('incident-form').url.placeholder = `${meta.incidentBaseUrl ?? 'https://…'}/…`;

  $('faq-card').hidden = !detail.faqDraft;
  if (detail.faqDraft) {
    const f = $('faq-form');
    f.title.value = detail.faqDraft.title;
    f.question.value = detail.faqDraft.question;
    f.answer.value = detail.faqDraft.answer;
  }
}

function updateStatusFields() {
  const to = $('status-form').to.value;
  $('resolution-fields').hidden = to !== 'RESOLVED';
  $('note-label').firstChild.textContent = to === 'ON_HOLD' ? '보류 사유 (필수) ' : '메모 (선택) ';
}

/** 작업 요청 → 성공하면 서버가 돌려준 최신 상세로 다시 그린다 */
async function act(path, method, body, form) {
  hideError('action-error');
  const button = form?.querySelector('button[type=submit]');
  if (button) button.disabled = true;
  try {
    detail = await api(`/api/tickets/${id}/${path}`, { method, body });
    render();
    if (form && form.id !== 'status-form') form.reset();
  } catch (err) {
    showError('action-error', err);
    $('action-error').scrollIntoView({ block: 'nearest' });
  } finally {
    if (button) button.disabled = false;
  }
}

function wireForms() {
  $('assign-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('assign', 'POST', { assigneeEmpNo: e.target.assigneeEmpNo.value }, e.target);
  });
  $('status-form').to.addEventListener('change', updateStatusFields);
  $('status-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { to: f.to.value, note: f.note.value };
    if (body.to === 'RESOLVED') Object.assign(body, { cause: f.cause.value, action: f.action.value, verification: f.verification.value });
    act('status', 'POST', body, f);
  });
  $('note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('notes', 'POST', { note: e.target.note.value }, e.target);
  });
  $('incident-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('incident-link', 'PUT', { url: e.target.url.value }, null);
  });
  $('faq-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act('faq', 'POST', { title: f.title.value, question: f.question.value, answer: f.answer.value }, f);
  });
}

try {
  await initShell('tickets');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('잘못된 티켓 번호입니다');
  meta = await loadMeta();
  detail = await api(`/api/tickets/${id}`);
  if (meta.viewer.isItStaff) wireForms();
  render();
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
