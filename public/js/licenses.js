// 라이선스 현황: 초과·만료 임박·비인가 SW (IT 담당자 전용)
// 색만으로 구분하지 않도록 경고에는 항상 글자를 함께 쓴다.

import { api, el, $, initShell, showError } from './common.js';

const EXPIRY_LABEL = { PERPETUAL: '영구', OK: '정상', EXPIRING: '만료 임박', EXPIRED: '만료' };
const TYPE_LABEL = { PERPETUAL: '영구', SUBSCRIPTION: '구독' };

function summaryCard(label, value, tone, hint) {
  return el(
    'div',
    { class: `summary-card ${value > 0 ? tone : 'ok'}` },
    el('div', { class: 'summary-value', text: String(value) }),
    el('div', { class: 'summary-label', text: label }),
    hint ? el('div', { class: 'muted small', text: hint }) : null,
  );
}

function usageBar(l) {
  const ratio = l.quantity > 0 ? l.installed / l.quantity : l.installed > 0 ? 2 : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  return el(
    'div',
    { class: 'usage', title: `${l.installed} / ${l.quantity}` },
    el('div', { class: `usage-bar${l.over ? ' over' : ratio >= 0.9 ? ' high' : ''}`, style: `width:${pct}%` }),
  );
}

function expiryText(e, expiresOn) {
  if (e.state === 'PERPETUAL') return '영구';
  if (e.state === 'EXPIRED') return `${expiresOn} (만료 ${-e.daysLeft}일 지남)`;
  return `${expiresOn} (${e.daysLeft}일 남음)`;
}

function render(r) {
  $('as-of').textContent = `기준일 ${r.today} (KST)`;
  $('summary').replaceChildren(
    summaryCard('수량 초과', r.summary.over, 'danger', '설치 수 > 보유 수량'),
    summaryCard('만료 임박', r.summary.expiring, 'warn', '30일 이내'),
    summaryCard('만료', r.summary.expired, 'danger'),
    summaryCard('비인가 SW', r.summary.unauthorizedSoftware, 'danger', `${r.summary.unauthorizedAssets}대에 설치`),
  );

  // 경고가 있는 라이선스를 위로
  const rank = (l) => (l.over ? 0 : l.expiry.state === 'EXPIRED' ? 1 : l.expiry.state === 'EXPIRING' ? 2 : 3);
  const rows = [...r.licenses].sort((a, b) => rank(a) - rank(b) || a.id - b.id);

  $('license-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['제품', '유형', '계약 업체', '보유', '설치', '사용률', '만료일', '상태'].map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      {},
      rows.map((l) => {
        const badges = [];
        if (l.over) badges.push(el('span', { class: 'badge sla-overdue', text: `초과 ${l.overBy}` }));
        if (l.expiry.state === 'EXPIRING' || l.expiry.state === 'EXPIRED') {
          badges.push(el('span', { class: `badge ${l.expiry.state === 'EXPIRED' ? 'sla-overdue' : 'sla-imminent'}`, text: EXPIRY_LABEL[l.expiry.state] }));
        }
        if (!badges.length) badges.push(el('span', { class: 'badge sla-on_track', text: '정상' }));
        return el(
          'tr',
          { class: l.over || l.expiry.state !== 'OK' && l.expiry.state !== 'PERPETUAL' ? 'row-alert' : null },
          el('td', {}, el('strong', { text: l.productName }), el('div', { class: 'muted small', text: l.contractNo ?? '' })),
          el('td', { text: TYPE_LABEL[l.licenseType] ?? l.licenseType }),
          el('td', { text: l.vendor }),
          el('td', { class: 'num', text: String(l.quantity) }),
          el('td', { class: 'num', text: String(l.installed) }),
          el('td', {}, usageBar(l)),
          el('td', { class: 'small nowrap', text: expiryText(l.expiry, l.expiresOn) }),
          el('td', {}, el('div', { class: 'badges' }, badges)),
        );
      }),
    ),
  );

  $('unauthorized').replaceChildren(
    ...(r.unauthorized.length
      ? r.unauthorized.map((u) =>
          el(
            'div',
            { class: 'unauth-item' },
            el('div', {}, el('span', { class: 'badge sw-unauthorized', text: '비인가' }), ' ', el('strong', { text: u.softwareName }), el('span', { class: 'muted small', text: ` · ${u.assetCount}대` })),
            el(
              'ul',
              { class: 'plain-list small' },
              u.assets.map((a) =>
                el('li', {}, el('a', { href: `/asset?id=${a.id}`, text: a.assetTag }), ` ${a.holderName ?? a.location ?? '사용자 없음'}`),
              ),
            ),
          ),
        )
      : [el('p', { class: 'muted', text: '비인가 소프트웨어가 없습니다.' })]),
  );
}

try {
  const me = await initShell('licenses');
  if (me.persona !== 'it_admin') throw new Error('IT 담당자만 볼 수 있는 화면입니다');
  render(await api('/api/licenses'));
} catch (err) {
  if (err.status !== 401) showError('page-error', err);
}
