// 데모 로그인 화면

const errorBox = document.getElementById('login-error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

// 이미 로그인돼 있으면 바로 홈으로
const me = await fetch('/api/me');
if (me.ok) location.replace('/app');

for (const button of document.querySelectorAll('[data-persona]')) {
  button.addEventListener('click', async () => {
    errorBox.hidden = true;
    button.disabled = true;
    try {
      const res = await fetch('/api/demo/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persona: button.dataset.persona }),
      });
      if (res.ok) {
        location.assign('/app');
        return;
      }
      const body = await res.json().catch(() => null);
      showError(body?.error?.message ?? `로그인 실패 (${res.status})`);
    } catch {
      showError('서버에 연결할 수 없습니다');
    } finally {
      button.disabled = false;
    }
  });
}
