// 자산 상세: 정보, 배정 이력, 설치 SW, 관련 티켓, 배정·반납·상태 변경 (IT 담당자 전용)

import { api, el, $, initShell, showError, hideError, formatKst } from './common.js';

const id = Number(new URLSearchParams(location.search).get('id'));
let meta;
let detail;

const SW_CLASS = {
  LICENSED: ['라이선스', 'sw-licensed'],
  ALLOWED: ['허용', 'sw-allowed'],
  UNAUTHORIZED: ['비인가', 'sw-unauthorized'],
};

function table(target, headers, rows) {
  target.replaceChildren(
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: headers.length, class: 'muted', text: '없음' }))),
  );
}

function render() {
  const a = detail.asset;
  document.title = `${a.assetTag} · 도담테크산업 IT 운영 포털 (시뮬레이션)`;
  $('title').textContent = `${a.assetTag} ${a.manufacturer} ${a.model}`;
  $('badges').replaceChildren(
    el('span', { class: `badge asset-${a.status.toLowerCase()}`, text: meta.statuses[a.status] }),
    el('span', { class: 'badge', text: meta.types[a.assetType] }),
  );

  const rows = [
    ['종류', meta.types[a.assetType]],
    ['제조사', a.manufacturer],
    ['모델', a.model],
    ['시리얼', a.serialNo],
    ['구매일', a.purchasedOn],
    a.holder ? ['사용자', `${a.holder.name} (${a.holder.department}) · ${formatKst(a.holder.since)}부터`] : null,
    a.location ? ['위치', a.location] : null,
    a.statusNote ? ['상태 사유', a.statusNote] : null,
    a.statusChangedAt ? ['상태 변경', formatKst(a.statusChangedAt)] : null,
  ].filter(Boolean);
  $('info').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));

  table(
    $('history'),
    ['사용자', '배정', '반납', '반납 상태'],
    detail.assignments.map((x) =>
      el(
        'tr',
        {},
        el('td', { text: `${x.employee.name} (${x.employee.department})` }),
        el('td', { class: 'small', text: `${formatKst(x.assignedAt)}${x.assignNote ? ` · ${x.assignNote}` : ''}` }),
        el('td', { class: 'small', text: x.returnedAt ? `${formatKst(x.returnedAt)}${x.returnNote ? ` · ${x.returnNote}` : ''}` : '사용 중' }),
        el('td', { text: x.returnCondition ? meta.returnConditions[x.returnCondition] : '-' }),
      ),
    ),
  );

  table(
    $('software'),
    ['소프트웨어', '버전', '설치일', '분류'],
    detail.software.map((s) => {
      const [label, cls] = SW_CLASS[s.classification];
      return el(
        'tr',
        {},
        el('td', { text: s.name }),
        el('td', { text: s.version ?? '-' }),
        el('td', { class: 'small', text: s.installedOn ?? '-' }),
        el('td', {}, el('span', { class: `badge ${cls}`, text: s.licenseName ? `${label}: ${s.licenseName}` : label })),
      );
    }),
  );

  $('tickets').replaceChildren(
    ...(detail.tickets.length
      ? detail.tickets.map((t) =>
          el('li', {}, el('a', { href: `/ticket?id=${t.id}`, text: `${t.ticketNo} ${t.title}` }), el('span', { class: 'muted small', text: ` · ${t.requesterName} · ${formatKst(t.createdAt)}` })),
        )
      : [el('li', { class: 'muted', text: '연결된 티켓 없음' })]),
  );

  renderActions(a);
  $('asset').hidden = false;
}

function renderActions(a) {
  const assignable = meta.assignableTypes.includes(a.assetType);
  $('shared-note').hidden = assignable;
  $('assign-card').hidden = !(assignable && a.status === 'IN_STOCK');
  $('return-card').hidden = !a.holder;
  $('status-card').hidden = detail.allowedStatusChanges.length === 0;

  const assign = $('assign-form');
  assign.empNo.replaceChildren(
    el('option', { value: '', text: '선택하세요' }),
    ...meta.employees.map((e) => el('option', { value: e.empNo, text: `${e.name} ${e.jobTitle} (${e.department})` })),
  );
  assign.reset();

  const ret = $('return-form');
  ret.condition.replaceChildren(...Object.entries(meta.returnConditions).map(([v, l]) => el('option', { value: v, text: l })));
  ret.reset();
  updateNoteLabels();

  const st = $('status-form');
  st.to.replaceChildren(...detail.allowedStatusChanges.map((s) => el('option', { value: s, text: meta.statuses[s] })));
  st.reset();
  updateNoteLabels();
}

function updateNoteLabels() {
  $('return-note-label').firstChild.textContent = $('return-form').condition.value === 'REPAIR' ? '고장 내용 (필수) ' : '메모 (선택) ';
  const to = $('status-form').to.value;
  $('status-note-label').firstChild.textContent = to === 'IN_STOCK' ? '메모 (선택) ' : `${to === 'DISPOSED' ? '폐기' : '수리'} 사유 (필수) `;
}

async function act(path, body, form) {
  hideError('action-error');
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    detail = await api(`/api/assets/${id}/${path}`, { method: 'POST', body });
    render();
  } catch (err) {
    showError('action-error', err);
  } finally {
    button.disabled = false;
  }
}

try {
  const me = await initShell('assets');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('잘못된 자산 번호입니다');
  [meta, detail] = await Promise.all([api('/api/assets/meta'), api(`/api/assets/${id}`)]);

  $('return-form').condition.addEventListener('change', updateNoteLabels);
  $('status-form').to.addEventListener('change', updateNoteLabels);
  $('assign-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('assign', { empNo: e.target.empNo.value, note: e.target.note.value }, e.target);
  });
  $('return-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('return', { condition: e.target.condition.value, note: e.target.note.value }, e.target);
  });
  $('status-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act('status', { to: e.target.to.value, note: e.target.note.value }, e.target);
  });
  render();
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
