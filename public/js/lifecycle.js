// 입·퇴사 목록: 미처리 퇴사자 경고, 케이스 목록, 케이스 만들기 (IT 담당자 전용)

import { api, el, $, initShell, showError, hideError, formatKst } from './common.js';

function render(data) {
  $('today').textContent = `기준일 ${data.today} (KST)`;

  $('warnings').hidden = data.warnings.length === 0;
  $('warning-list').replaceChildren(
    ...data.warnings.map((w) =>
      el(
        'li',
        {},
        el('strong', { text: `${w.name} (${w.empNo}, ${w.department})` }),
        ` — 퇴사일 ${w.resignDate}, ${w.daysOverdue}일 지남 · 활성 계정 `,
        ...w.accounts.flatMap((a, i) => [i ? ', ' : '', el('a', { href: `/dir-user?id=${a.id}`, class: 'mono', text: a.sam })]),
        ' · ',
        w.caseId ? el('a', { href: `/lifecycle-case?id=${w.caseId}`, text: `처리 중 (케이스 #${w.caseId})` }) : el('span', { class: 'badge sla-overdue', text: '퇴사 케이스 없음' }),
      ),
    ),
  );

  $('cases').replaceChildren(
    el('thead', {}, el('tr', {}, ['#', '종류', '직원', '기준일', '진행', '상태'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      data.cases.map((c) =>
        el(
          'tr',
          {},
          el('td', {}, el('a', { href: `/lifecycle-case?id=${c.id}`, text: `#${c.id}` })),
          el('td', {}, el('span', { class: `badge case-${c.caseType.toLowerCase()}`, text: c.label })),
          el('td', {}, el('a', { href: `/lifecycle-case?id=${c.id}`, text: `${c.name} (${c.empNo})` }), el('div', { class: 'muted small', text: c.department })),
          el('td', { class: 'nowrap', text: `${c.caseType === 'ONBOARDING' ? '입사' : '퇴사'}일 ${c.effectiveDate}` }),
          el(
            'td',
            {},
            el('div', { class: 'usage' }, el('div', { class: 'usage-bar', style: `width:${Math.round((c.progress.done / c.progress.total) * 100)}%` })),
            el('span', { class: 'small muted', text: ` ${c.progress.done}/${c.progress.total}` }),
          ),
          el('td', { text: c.status === 'COMPLETED' ? `완료 · ${formatKst(c.completedAt)}` : '진행 중' }),
        ),
      ),
    ),
  );

  const off = $('off-form');
  off.empNo.replaceChildren(
    el('option', { value: '', text: '선택하세요' }),
    ...data.offboardCandidates.map((e) =>
      el('option', { value: e.empNo, text: `${e.name} (${e.empNo}, ${e.department} ${e.jobTitle})${e.resignDate ? ` · 퇴사일 ${e.resignDate}` : ''}` }),
    ),
  );
  off.effectiveDate.value = data.today;
  const on = $('on-form');
  on.deptCode.replaceChildren(el('option', { value: '', text: '선택하세요' }), ...data.departments.map((d) => el('option', { value: d.code, text: d.name })));
}

async function submit(form, errorId, body) {
  hideError(errorId);
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const r = await api('/api/lifecycle/cases', { method: 'POST', body });
    location.assign(`/lifecycle-case?id=${r.case.id}`);
  } catch (err) {
    showError(errorId, err);
    button.disabled = false;
  }
}

try {
  const me = await initShell('lifecycle');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  const data = await api('/api/lifecycle/cases');
  render(data);

  $('off-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    submit(f, 'off-error', { caseType: 'OFFBOARDING', empNo: f.empNo.value, effectiveDate: f.effectiveDate.value, note: f.note.value });
  });
  $('on-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    submit(f, 'on-error', { caseType: 'ONBOARDING', name: f.name.value, deptCode: f.deptCode.value, jobTitle: f.jobTitle.value, hireDate: f.hireDate.value });
  });
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
