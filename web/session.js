const userChip = document.querySelector('.user-chip');

async function loadSessionUser() {
  const response = await fetch('/auth/session', { credentials: 'same-origin' });
  if (response.status === 401) {
    location.assign('/login');
    return;
  }
  if (!response.ok) return;
  const { user } = await response.json();
  if (!userChip || !user) return;
  const name = user.username || user.email || 'Administrator';
  userChip.replaceChildren();

  const avatar = document.createElement('span');
  avatar.className = 'user-avatar';
  avatar.innerHTML = '<img src="/icons/users.svg" alt="">';
  const copy = document.createElement('span');
  copy.className = 'user-copy';
  const strong = document.createElement('strong');
  strong.textContent = name;
  const small = document.createElement('small');
  small.textContent = user.email || 'admin';
  copy.append(strong, small);
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'icon-button logout-button';
  logout.title = '退出登录';
  logout.innerHTML = '<img src="/icons/log-out.svg" alt="">';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      location.replace('/login');
    }
  });
  userChip.append(avatar, copy, logout);
}

loadSessionUser().catch(() => {});
