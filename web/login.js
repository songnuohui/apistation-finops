const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#form-error');
const submitButton = document.querySelector('#submit-button');
const totpField = document.querySelector('#totp-field');
const totpCode = document.querySelector('#totp-code');
let requiresTwoFactor = false;

function setError(message = '') {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.textContent = loading ? '正在验证' : requiresTwoFactor ? '验证并登录' : '登录';
}

async function sessionExists() {
  const response = await fetch('/auth/session', { credentials: 'same-origin' });
  if (response.ok) location.replace('/');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError();
  setLoading(true);
  const payload = requiresTwoFactor
    ? { totpCode: totpCode.value }
    : { email: form.email.value.trim(), password: form.password.value };
  try {
    const response = await fetch(requiresTwoFactor ? '/auth/login/2fa' : '/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录失败');
    if (data.requiresTwoFactor) {
      requiresTwoFactor = true;
      totpField.hidden = false;
      totpCode.required = true;
      form.password.value = '';
      form.password.disabled = true;
      form.email.disabled = true;
      totpCode.focus();
      setLoading(false);
      return;
    }
    location.replace('/');
  } catch (error) {
    setError(error.message || '登录失败，请稍后重试');
    setLoading(false);
  }
});

sessionExists().catch(() => {});
