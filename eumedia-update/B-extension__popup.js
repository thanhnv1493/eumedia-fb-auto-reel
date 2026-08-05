const server = document.querySelector('#server');
const page = document.querySelector('#page');
const status = document.querySelector('#status');

chrome.storage.local.get({ serverUrl: 'http://localhost:3000', pageId: '', botId: '' }).then(value => {
  server.value = value.serverUrl;
  page.value = value.pageId || 'Chưa kết nối';
});

async function adsPowerStartupIdentity() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url || '');
      if (url.hostname !== 'start.adspower.net') continue;
      const profileId = url.searchParams.get('id');
      if (profileId) return { profileId };
    } catch (_) {
      // Ignore browser-internal tabs and continue looking for AdsPower's tab.
    }
  }
  return {};
}

document.querySelector('#save').addEventListener('click', async () => {
  const serverUrl = server.value.replace(/\/$/, '');
  try {
    const adsPowerStartup = await adsPowerStartupIdentity();
    status.textContent = adsPowerStartup.profileId
      ? 'Đã đọc tab khởi động AdsPower, đang gán đúng Số Profile…'
      : 'Đang đối chiếu đúng Số Profile AdsPower (có thể mất 10–15 giây)…';
    status.style.color = '#5f6368';
    const target = new URL(serverUrl);
    const isLocal = ['localhost', '127.0.0.1'].includes(target.hostname);
    if (!isLocal) {
      const allowed = await chrome.permissions.request({ origins: [`${target.protocol}//${target.hostname}/*`] });
      if (!allowed) throw new Error('Chưa được cấp quyền mạng');
    }
    const response = await fetch(`${serverUrl}/api/state`);
    if (!response.ok) throw new Error('A không phản hồi');
    const existing = await chrome.storage.local.get({ pageId: '', botId: '' });
    const connect = await fetch(`${serverUrl}/api/pages/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageId: existing.pageId,
        legacyId: existing.botId,
        browser: {
          userAgent: navigator.userAgent,
          platform: navigator.platform || '',
          language: navigator.language || '',
          adsPowerProfileId: adsPowerStartup.profileId || ''
        }
      })
    });
    if (!connect.ok) {
      const detail = await connect.json().catch(() => ({}));
      throw new Error(detail.error || 'Không cấp được Page mới từ A');
    }
    const connected = await connect.json();
    const pageId = connected.pageId;
    const heartbeat = await fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Page kết nối thủ công từ extension' })
    });
    if (!heartbeat.ok) {
      const detail = await heartbeat.json().catch(() => ({}));
      throw new Error(detail.error || 'Page chưa gửi được trạng thái Online về A');
    }
    await chrome.storage.local.set({ serverUrl, pageId });
    await chrome.storage.local.remove('botId');
    page.value = pageId;
    chrome.runtime.sendMessage({ type: 'connect_now' });
    const autoBind = connected.adsPowerAutoBind || {};
    status.textContent = autoBind.status === 'matched'
      ? `✓ ${pageId} đã Online · tự gán Số Profile ${autoBind.profileNumber}.`
      : autoBind.status === 'already_bound'
        ? `✓ ${pageId} đã Online · đang gán Số Profile ${autoBind.profileNumber}.`
        : autoBind.status === 'ambiguous'
          ? `✓ ${pageId} đã Online · có ${autoBind.matchedUserAgents || autoBind.activeCount || 0} Profile trùng dấu nhận diện nên A không gán nhầm.`
          : autoBind.status === 'not_found'
            ? `✓ ${pageId} đã Online · A chưa khớp được Profile AdsPower.`
            : `✓ ${pageId} đã Online trên A.`;
    status.style.color = '#137333';
  } catch (error) {
    status.textContent = error.message || '✕ Không kết nối được A. Mở A.exe trước và kiểm tra địa chỉ.';
    status.style.color = '#b3261e';
  }
});
