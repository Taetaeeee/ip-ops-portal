// 입·퇴사 케이스 체크리스트: 항목 실행(A-4 디렉터리·A-3 자산 연동), 연결 결과, 담당자 (IT 담당자 전용)

import { api, el, $, initShell, showError, hideError, formatKst } from './common.js';

const id = Number(new URLSearchParams(location.search).get('id'));
let detail;

const STATE_LABEL = { DONE: '완료', READY: '실행 가능', BLOCKED: '대기 (선행 미완료)' };
const BUTTON_LABEL = {
  CREATE_ACCOUNT: '계정 생성 실행 (A-4)',
  ADD_ROLE_GROUPS: '업무 그룹 추가 실행 (A-4)',
  ISSUE_DEVICE: '장비 지급 (A-3)',
  ASSIGN_SOFTWARE: '표준 SW 배정',
  USER_GUIDE: '안내 완료',
  DISABLE_ACCOUNT: '계정 비활성화 실행 (A-4)',
  REMOVE_GROUPS: '그룹 전부 제거 실행 (A-4)',
  MOVE_TO_FORMER_OU: '퇴사자 OU 이동 실행 (A-4)',
  CONFIRM_BACKUP: '백업 확인 완료',
  RETURN_DEVICES: '장비 전부 반납 (A-3)',
  RECLAIM_LICENSES: '라이선스 회수',
};
const EMP_STATUS = { UPCOMING: '입사 예정', ACTIVE: '재직', LAST_DAY: '퇴사일 당일', RESIGNED: '퇴사' };

function stateCards(d) {
  const card = (label, value, sub, tone = '') =>
    el('div', { class: `summary-card ${tone}` }, el('div', { class: 'summary-label', text: label }), el('div', { class: 'state-value', text: value }), sub ? el('div', { class: 'muted small break', text: sub }) : null);
  const a = d.account;
  return [
    card('인사', `${EMP_STATUS[d.employee.status]}`, `입사 ${d.employee.hireDate}${d.employee.resignDate ? ` · 퇴사 ${d.employee.resignDate}` : ''}`),
    card(
      'AD 계정',
      a ? `${a.sam} · ${a.enabled ? '활성' : '비활성'}` : '없음',
      a ? `${a.ouPath} · 그룹 ${a.groups.length}개${a.groups.length ? ` (${a.groups.join(', ')})` : ''}` : null,
      a && d.case.caseType === 'OFFBOARDING' && a.enabled ? 'warn' : '',
    ),
    card('배정 장비', d.devices.length ? d.devices.map((x) => x.assetTag).join(', ') : '없음', d.devices.map((x) => x.model).join(', ') || null),
  ];
}

function linkView(l) {
  if (l.operation) {
    return el(
      'li',
      {},
      el('a', { href: `/dir-result?id=${l.operation.id}`, text: `A-4 작업 #${l.operation.id} ${l.operation.label}` }),
      l.detail?.group ? el('span', { class: 'mono', text: ` ${l.detail.group}` }) : '',
      l.detail?.already ? el('span', { class: 'muted', text: ' (기존 작업 연결)' }) : '',
      ' · 스크립트(미실행) · 이벤트 ',
      ...l.operation.eventIds.map((e) => el('span', { class: `badge ev-${e}`, text: String(e) })),
    );
  }
  const asset = l.asset ? el('a', { href: `/asset?id=${l.asset.id}`, class: 'mono', text: l.asset.assetTag }) : '';
  switch (l.type) {
    case 'ASSET_ASSIGN':
      return el('li', {}, '장비 지급: ', asset, ` ${l.asset?.model ?? ''}`);
    case 'ASSET_RETURN':
      return el('li', {}, '장비 반납 → 재고: ', asset);
    case 'SOFTWARE_INSTALL':
      return el('li', {}, '설치 기록: ', el('span', { text: l.detail.softwareName }), l.detail.licenseName ? el('span', { class: 'badge sw-licensed', text: l.detail.licenseName }) : el('span', { class: 'badge sw-allowed', text: '허용' }), ' · ', asset);
    case 'SOFTWARE_REMOVE':
      return el('li', {}, '회수: ', el('span', { text: l.detail.softwareName }), el('span', { class: 'badge sw-licensed', text: l.detail.licenseName }), ' · ', asset);
    default:
      return el('li', { text: l.type });
  }
}

function itemForm(item) {
  const form = el('form', { class: 'item-form', dataset: { itemId: String(item.id) } });
  if (item.itemKey === 'ISSUE_DEVICE') {
    form.append(
      el(
        'label',
        {},
        '지급할 재고 PC ',
        el('select', { name: 'assetId' }, el('option', { value: '', text: '선택하세요' }), ...detail.stockDevices.map((d) => el('option', { value: String(d.id), text: `${d.assetTag} ${d.model}` }))),
      ),
    );
  }
  if (item.itemKey === 'CREATE_ACCOUNT') {
    form.append(
      el('label', {}, '영문 성 (선택) ', el('input', { name: 'surnameEn', maxlength: '30', placeholder: '비우면 자동' })),
      el('label', {}, '영문 이름 (선택) ', el('input', { name: 'givenNameEn', maxlength: '30', placeholder: '비우면 자동' })),
    );
  }
  if (item.kind === 'MANUAL') {
    form.append(el('label', {}, `메모 (필수) `, el('textarea', { name: 'note', rows: '2', maxlength: '500', placeholder: item.noteRequired ?? '' })));
  }
  form.append(el('button', { type: 'submit', class: `button ${item.itemKey === 'DISABLE_ACCOUNT' ? 'danger' : 'primary'}`, text: BUTTON_LABEL[item.itemKey] ?? '완료' }));
  return form;
}

function render() {
  const d = detail;
  document.title = `${d.case.label} #${d.case.id} ${d.employee.name} · 도담테크산업 IT 운영 포털 (시뮬레이션)`;
  $('title').textContent = `${d.case.label} #${d.case.id} — ${d.employee.name} (${d.employee.empNo}, ${d.employee.department} ${d.employee.jobTitle})`;
  $('badges').replaceChildren(
    el('span', { class: `badge case-${d.case.caseType.toLowerCase()}`, text: `${d.case.label}일 ${d.case.effectiveDate}` }),
    el('span', { class: `badge ${d.case.status === 'COMPLETED' ? 'status-resolved' : 'status-received'}`, text: d.case.status === 'COMPLETED' ? '완료' : `진행 ${d.progress.done}/${d.progress.total}` }),
  );
  $('subtitle').textContent = `생성 ${d.case.createdBy} · ${formatKst(d.case.createdAt)}${d.case.note ? ` · ${d.case.note}` : ''}${d.case.completedAt ? ` · 완료 ${formatKst(d.case.completedAt)}` : ''}`;
  $('state-cards').replaceChildren(...stateCards(d));

  const byKey = Object.fromEntries(d.items.map((i) => [i.itemKey, i]));
  $('items').replaceChildren(
    ...d.items.map((item) =>
      el(
        'li',
        { class: `check-item state-${item.state.toLowerCase()}` },
        el(
          'div',
          { class: 'check-head' },
          el('span', { class: 'check-mark', 'aria-hidden': 'true', text: item.state === 'DONE' ? '✓' : String(item.seq) }),
          el('strong', { text: item.title }),
          el('span', { class: 'badge', text: item.kindLabel }),
          el('span', { class: `badge check-${item.state.toLowerCase()}`, text: STATE_LABEL[item.state] }),
        ),
        el(
          'div',
          { class: 'muted small check-meta' },
          item.requires.length ? `선행: ${item.requires.map((k) => byKey[k]?.title ?? k).join(', ')} · ` : '선행 없음 · ',
          `담당 ${item.assignee?.name ?? '-'}`,
          item.completedAt ? ` · 완료 ${item.completedBy} ${formatKst(item.completedAt)}` : '',
        ),
        item.state === 'BLOCKED' ? el('p', { class: 'small blocked-why', text: `먼저 완료해야 함: ${item.blockedBy.join(', ')}` }) : null,
        item.note ? el('p', { class: 'small pre', text: item.note }) : null,
        item.links.length ? el('ul', { class: 'plain-list small links' }, item.links.map(linkView)) : null,
        item.state === 'READY' && d.case.status === 'OPEN' ? itemForm(item) : null,
      ),
    ),
  );
  $('case').hidden = false;
}

$('items').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const item = detail.items.find((i) => String(i.id) === form.dataset.itemId);
  const body = {};
  for (const [k, v] of new FormData(form)) if (String(v).trim()) body[k] = k === 'assetId' ? Number(v) : String(v).trim();
  hideError('action-error');
  $('message').hidden = true;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = '실행 중…';
  try {
    const r = await api(`/api/lifecycle/cases/${id}/items/${item.id}/execute`, { method: 'POST', body });
    detail = r.detail;
    render();
    $('message').textContent = `${item.title}: ${r.message}${detail.case.status === 'COMPLETED' ? ' — 모든 항목 완료, 케이스가 완료되었습니다.' : ''}`;
    $('message').hidden = false;
  } catch (err) {
    showError('action-error', err);
    button.disabled = false;
    button.textContent = BUTTON_LABEL[item.itemKey] ?? '완료';
  }
});

try {
  const me = await initShell('lifecycle');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('잘못된 케이스 번호입니다');
  detail = await api(`/api/lifecycle/cases/${id}`);
  render();
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
