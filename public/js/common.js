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

/** 상단: 사용자 정보·메뉴 강조·로그아웃. 로그인 정보를 돌려준다. */
export async function initShell(active) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === active) a.setAttribute('aria-current', 'page');
  }
  $('logout')?.addEventListener('click', async () => {
    await fetch('/api/demo/logout', { method: 'POST' }).catch(() => {});
    location.replace('/');
  });
  const me = await api('/api/me');
  const e = me.employee;
  $('user-info').textContent = `${me.personaLabel} · ${e.name} ${e.jobTitle} (${e.department})`;
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
