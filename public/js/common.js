// 화면 공통 도우미: API 호출, 상단 메뉴, 날짜·SLA 표시
// 서버 값은 textContent 로만 넣는다 (innerHTML 을 쓰지 않아 HTML 주입이 생기지 않는다).

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `요청 실패 (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.errors = body?.error?.errors ?? [];
  }
}

/** API 호출. 401 이면 로그인 화면으로 보낸다. */
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    location.replace('/');
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/**
 * 요소 만들기. el('a', { class: 'x', href: '/y', text: '링크' }, 자식...)
 * text 는 textContent 로 들어간다.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (id) => document.getElementById(id);

/** 아이콘: /icons.svg 의 symbol 을 쓴다 (외부 라이브러리 없음) */
export function icon(name, className = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// 상단 메뉴: 한 곳에서 정의한다 (화면마다 복사하지 않음). itOnly 는 IT 담당자에게만 보인다.
export const NAV_ITEMS = Object.freeze([
  { key: 'home', href: '/app', label: '홈', icon: 'home' },
  { key: 'tickets', href: '/tickets', label: '헬프데스크', icon: 'ticket' },
  { key: 'faq', href: '/faq', label: 'FAQ', icon: 'help' },
  { key: 'assets', href: '/assets', label: '자산', icon: 'monitor', itOnly: true },
  { key: 'licenses', href: '/licenses', label: '라이선스', icon: 'key', itOnly: true },
  { key: 'directory', href: '/directory', label: '디렉터리', icon: 'sitemap', itOnly: true },
  { key: 'lifecycle', href: '/lifecycle', label: '입·퇴사', icon: 'users', itOnly: true },
]);

function renderHeader(active, me) {
  const header = $('app-header');
  if (!header) return;
  const isIt = me.persona === 'it_admin';
  const e = me.employee;
  header.replaceChildren(
    el(
      'a',
      { class: 'brand', href: '/app', 'aria-label': 'IT 운영 포털 홈' },
      el('span', { class: 'brand-logo' }, icon('logo')),
      el('span', { class: 'brand-text' }, el('strong', { text: 'IT 운영 포털' }), el('small', { text: '도담테크산업 · IT Operations Portal' })),
    ),
    el(
      'nav',
      { class: 'mainnav', 'aria-label': '주 메뉴' },
      // IT 전용 메뉴는 화면에서 숨기는 것일 뿐, 권한 검사는 서버가 한다
      NAV_ITEMS.filter((n) => !n.itOnly || isIt).map((n) =>
        el('a', { href: n.href, dataset: { nav: n.key }, 'aria-current': n.key === active ? 'page' : null }, icon(n.icon), el('span', { text: n.label })),
      ),
    ),
    el(
      'div',
      { class: 'user' },
      el('span', { class: 'avatar', 'aria-hidden': 'true', text: e.name.slice(0, 1) }),
      el('span', { class: 'user-text' }, el('strong', { id: 'user-info', text: `${e.name} ${e.jobTitle}` }), el('small', { text: `${me.personaLabel} · ${e.department}` })),
      el('button', { type: 'button', id: 'logout', class: 'icon-button', title: '로그아웃', 'aria-label': '로그아웃' }, icon('logout')),
    ),
  );
  $('logout').addEventListener('click', async () => {
    await fetch('/api/demo/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });
}

/** 상단 메뉴를 그리고 로그인 정보를 돌려준다. 로그인 전이면 로그인 화면으로 보낸다. */
export async function initShell(active) {
  const me = await api('/api/me');
  renderHeader(active, me);
  return me;
}

let metaPromise;
export function loadMeta() {
  metaPromise ??= api('/api/helpdesk/meta');
  return metaPromise;
}

export function showError(target, err) {
  const box = typeof target === 'string' ? $(target) : target;
  box.replaceChildren(el('strong', { text: err.message }));
  if (err.errors?.length) box.append(el('ul', {}, err.errors.map((x) => el('li', { text: x.message }))));
  box.hidden = false;
}

export function hideError(target) {
  const box = typeof target === 'string' ? $(target) : target;
  box.hidden = true;
  box.replaceChildren();
}

// ── 표시 형식 ──

export function formatKst(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatMinutes(min) {
  if (min === null || min === undefined) return '';
  // 전체를 먼저 분 단위로 반올림해야 "3시간 60분" 같은 표시가 생기지 않는다
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** SLA 표시: 색만으로 구분하지 않도록 글자도 함께 쓴다 */
export function slaBadge(sla, meta) {
  const label = meta.slaStates[sla.state] ?? sla.state;
  let text = label;
  if (sla.state === 'ON_TRACK' || sla.state === 'IMMINENT') text += ` · ${formatMinutes(sla.remainingMinutes)} 남음`;
  return el('span', { class: `badge sla-${sla.state.toLowerCase()}`, text, title: `기한 ${formatKst(sla.dueAt)} (업무 시간 기준)` });
}

export function statusBadge(status, meta) {
  return el('span', { class: `badge status-${status.toLowerCase()}`, text: meta.statuses[status] ?? status });
}

export function priorityBadge(priority, meta) {
  return el('span', { class: `badge pri-${priority.toLowerCase()}`, text: meta.priorities[priority] ?? priority });
}
