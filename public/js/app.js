// 로그인 후 홈 화면
// 서버 값은 textContent 로만 넣는다 (innerHTML 을 쓰지 않아 HTML 주입이 생기지 않는다).

const $ = (id) => document.getElementById(id);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message) {
  $('app-error').textContent = message;
  $('app-error').hidden = false;
}

function formatKst(iso) {
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.replace('/');
    return null;
  }
  if (!res.ok) throw new Error(`${url} 응답 ${res.status}`);
  return res.json();
}

function renderUser(me) {
  const e = me.employee;
  $('user-info').textContent = `${me.personaLabel} · ${e.name} ${e.jobTitle} (${e.department})`;
}

function renderSummary(summary) {
  const c = summary.company;
  $('company-line').textContent = `${c.business} · 직원 ${summary.totalHeadcount}명`;

  const container = $('sites');
  container.replaceChildren();
  for (const site of summary.sites) {
    const card = el('article', undefined, 'card');
    card.append(el('h3', `${site.name} · ${site.headcount}명`));

    const table = el('table');
    const head = el('tr');
    head.append(el('th', '부서'), el('th', '인원'));
    table.append(head);
    for (const d of site.departments) {
      const row = el('tr');
      row.append(el('td', d.name), el('td', `${d.headcount}명`, 'num'));
      table.append(row);
    }
    card.append(table);
    container.append(card);
  }

  $('last-reset').textContent = summary.lastReset
    ? `마지막 데모 초기화: ${formatKst(summary.lastReset.finishedAt)} (${summary.lastReset.trigger === 'cron' ? '자동' : '수동'})`
    : '데모 초기화 기록이 없습니다.';
}

$('logout').addEventListener('click', async () => {
  await fetch('/api/demo/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
});

try {
  const me = await getJson('/api/me');
  if (me) {
    renderUser(me);
    const summary = await getJson('/api/org/summary');
    if (summary) renderSummary(summary);
  }
} catch (err) {
  showError(`데이터를 불러오지 못했습니다: ${err.message}`);
}
