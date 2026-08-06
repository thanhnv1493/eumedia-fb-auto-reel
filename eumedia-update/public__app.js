let state = null;
let selectedId = null;
// Keep locally edited settings intact while the dashboard polls for updates.
let configDirty = false;
let adsSettingsDirty = false;
let adsBindingDirty = false;
let notificationSettingsDirty = false;
let networkSettingsDirty = false;
let selectionInitialized = false;
let upcomingExpanded = false;

const $ = selector => document.querySelector(selector);
const time = value => value ? new Date(value).toLocaleString('vi-VN') : 'Chưa có';

function updateAppClock() {
  const clock = $('#app-clock');
  if (!clock) return;
  const now = new Date();
  clock.textContent = `${now.toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })} · ${now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function request(url, options) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json()).error || 'Không thể thực hiện');
  return response.json();
}

function latestLog(botId) { return state.logs.find(log => log.botId === botId); }

function suggestedTimes(postsPerDay) {
  const count = Math.max(1, Math.min(50, Number(postsPerDay) || 1));
  if (count === 1) return ['09:00'];
  const start = 9 * 60;
  const end = 21 * 60;
  return Array.from({ length: count }, (_, index) => {
    const minute = Math.round(start + ((end - start) * index) / (count - 1));
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  });
}

function setupCustomTimeSelectors() {
  const hour = $('#custom-hour');
  const minute = $('#custom-minute');
  if (!hour || !minute || hour.options.length || minute.options.length) return;
  hour.innerHTML = Array.from({ length: 24 }, (_, value) => `<option value="${String(value).padStart(2, '0')}">${String(value).padStart(2, '0')}</option>`).join('');
  minute.innerHTML = Array.from({ length: 60 }, (_, value) => `<option value="${String(value).padStart(2, '0')}">${String(value).padStart(2, '0')}</option>`).join('');
  hour.value = '09';
  minute.value = '00';
}

function parseScheduleTimes(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(item => String(item).trim()).filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item)))].sort();
}

function renderSelectedTimeChips(times) {
  const chips = $('#selected-time-chips');
  if (!chips) return;
  const selected = parseScheduleTimes(times);
  chips.innerHTML = selected.length
    ? selected.map(value => `<span class="time-chip">${value}<button type="button" data-time="${value}" aria-label="Bỏ giờ ${value}" title="Bỏ giờ ${value}">×</button></span>`).join('')
    : '<span class="empty-times">Chưa chọn giờ đăng</span>';
  chips.querySelectorAll('.time-chip button').forEach(button => button.addEventListener('click', () => {
    const values = selected.filter(value => value !== button.dataset.time);
    $('#schedule-times').value = values.join(', ');
    $('#posts-per-day').value = Math.max(1, values.length);
    configDirty = true;
    renderSelectedTimeChips(values);
  }));
}

function selectedBot() {
  return state?.bots?.find(bot => bot.id === selectedId);
}

function profileNumber(bot) {
  return String(bot?.adsPower?.profileNumber || '').trim();
}

function hasPostingSchedule(bot) {
  const times = parseScheduleTimes(bot?.schedule?.times || []);
  return Boolean(times.length && Number(bot?.schedule?.postsPerDay) > 0);
}

function nextScheduledLabel(bot) {
  const times = parseScheduleTimes(bot?.schedule?.times || []);
  if (!times.length) return 'Chưa có lịch đăng.';
  const now = new Date();
  const candidates = times.map(value => {
    const [hour, minute] = value.split(':').map(Number);
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date;
  }).sort((first, second) => first - second);
  const next = candidates[0];
  return `Lịch kế tiếp: ${next.toLocaleString('vi-VN')}${bot?.schedule?.repeatDaily === false ? '' : ' · lặp mỗi ngày'}`;
}

function upcomingScheduleSlots(bot, count) {
  const times = parseScheduleTimes(bot?.schedule?.times || []);
  if (!times.length) return Array(count).fill('Chưa có lịch');
  const now = new Date();
  const slots = [];
  for (let dayOffset = 0; slots.length < count && dayOffset < 90; dayOffset += 1) {
    for (const value of times) {
      const [hour, minute] = value.split(':').map(Number);
      const date = new Date(now);
      date.setDate(now.getDate() + dayOffset);
      date.setHours(hour, minute, 0, 0);
      if (date > now) slots.push(date.toLocaleString('vi-VN'));
      if (slots.length === count) break;
    }
  }
  return slots;
}

function renderManualProfileNumber() {
  const input = $('#ads-profile-number');
  if (input && !adsBindingDirty) input.value = profileNumber(selectedBot());
}

function renderAdsPowerSetup() {
  const config = state?.adsPower || {};
  const layout = config.windowLayout || {};
  const status = $('#adspower-status');
  if (!adsSettingsDirty) {
    $('#ads-base-url').value = config.baseUrl || 'http://local.adspower.net:50325';
    $('#ads-window-layout-enabled').checked = layout.enabled !== false;
    $('#ads-window-width').value = layout.width || 960;
    $('#ads-window-height').value = layout.height || 540;
    $('#ads-window-columns').value = layout.columns || 2;
  }
  $('#ads-api-key').placeholder = config.configured ? 'API key đã lưu trên máy — để trống nếu không đổi' : 'Dán API key để kết nối';
  status.textContent = config.configured ? 'Đã lưu cấu hình' : 'Chưa kết nối';
  status.className = `ads-status${config.configured ? ' ready' : ''}`;
  renderManualProfileNumber();
}

function renderNotificationSetup() {
  const config = state?.notifications || {};
  const telegram = config.telegram || {};
  const ai = config.ai || {};
  const status = $('#telegram-status');
  if (!notificationSettingsDirty) {
    $('#telegram-token').value = '';
    $('#telegram-chat-id').value = '';
    $('#telegram-enabled').checked = Boolean(telegram.enabled);
    $('#ai-api-key').value = '';
    $('#ai-model').value = ai.model || 'gpt-5.6-sol';
    $('#ai-enabled').checked = Boolean(ai.enabled);
  }
  $('#telegram-token').placeholder = telegram.configured ? 'Bot Token đã lưu — để trống nếu không đổi' : 'Dán Bot Token từ BotFather';
  $('#telegram-chat-id').placeholder = telegram.configured ? `Chat ID đã lưu ${telegram.chatId || ''} — để trống nếu không đổi` : 'Ví dụ: 123456789';
  $('#ai-api-key').placeholder = ai.configured ? 'OpenAI API key đã lưu — để trống nếu không đổi' : 'Dán OpenAI API key để AI phân tích';
  status.textContent = telegram.configured
    ? (telegram.enabled ? (ai.enabled && ai.configured ? 'AI & Telegram đang bật' : 'Telegram đang bật') : 'Đã lưu Telegram')
    : 'Chưa thiết lập';
  status.className = `ads-status${telegram.configured ? ' ready' : ''}`;
}

function networkModeLabel(mode) {
  return ({ hub: 'A Trung tâm', worker: 'Máy Worker', standalone: 'Chạy độc lập' })[mode] || 'Chạy độc lập';
}

function renderHubMonitor() {
  const panel = $('#hub-monitor');
  const network = state?.network || {};
  const machines = state?.hubMachines || [];
  panel.hidden = network.mode !== 'hub';
  if (network.mode !== 'hub') return;
  const aiSummary = state?.hubAiAnalysis || {};
  const aiSummaryElement = $('#hub-ai-summary');
  aiSummaryElement.hidden = !aiSummary.text;
  aiSummaryElement.textContent = aiSummary.text ? `AI đọc lỗi chung${aiSummary.at ? ` · ${time(aiSummary.at)}` : ''}:\n${aiSummary.text}` : '';
  $('#hub-machine-count').textContent = `${machines.length} máy`;
  const list = $('#hub-machine-list');
  list.innerHTML = '';
  if (!machines.length) {
    const row = document.createElement('li');
    row.textContent = 'Chưa có Worker nào gửi báo cáo về Hub.';
    list.append(row);
    return;
  }
  machines.forEach(machine => {
    const row = document.createElement('li');
    const online = Date.now() - Date.parse(machine.receivedAt || machine.lastSeenAt || 0) < 75_000;
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = machine.machineName || machine.machineId;
    const stateLabel = document.createElement('span');
    stateLabel.className = `worker-state ${online ? 'online' : 'offline'}`;
    stateLabel.textContent = online ? 'Online' : 'Mất kết nối';
    heading.append(title, stateLabel);
    const info = document.createElement('small');
    const pages = machine.pages || [];
    const pageOnline = pages.filter(page => page.status === 'online').length;
    const ready = pages.reduce((total, page) => total + Number(page.ready || 0), 0);
    info.textContent = `${pageOnline}/${pages.length} Page online · ${ready} video sẵn sàng · bản ${machine.version || 'cũ'} · ${time(machine.receivedAt || machine.lastSeenAt)}`;
    row.append(heading, info);
    if (machine.errors?.length) {
      const error = document.createElement('p');
      error.className = 'error';
      error.textContent = `Lỗi mới nhất: ${machine.errors[0].message || 'Không rõ lỗi'}`;
      row.append(error);
    }
    list.append(row);
  });
}

function renderNetworkSetup() {
  const network = state?.network || {};
  const panel = $('#network-setup');
  const status = $('#network-status');
  if (!networkSettingsDirty) {
    $('#network-mode').value = network.mode || 'standalone';
    $('#network-machine-name').value = network.machineName || '';
    $('#network-hub-url').value = network.hubUrl || '';
    $('#network-shared-key').value = '';
  }
  panel.dataset.mode = network.mode || 'standalone';
  status.textContent = network.mode === 'worker'
    ? (network.paired ? 'Worker đã ghép nối' : 'Worker chưa ghép Hub')
    : network.mode === 'hub'
      ? (network.paired ? 'Hub đang sẵn sàng' : 'Hãy tạo mã ghép nối')
      : 'Chạy độc lập';
  status.className = `ads-status${network.mode !== 'standalone' && network.paired ? ' ready' : ''}`;
  $('#network-new-key').hidden = network.mode !== 'hub';
  $('#network-test').hidden = network.mode === 'standalone';
  $('#network-ai-summary').hidden = network.mode !== 'hub';
  $('#network-apply-update').hidden = network.mode !== 'worker';
  $('#network-shared-key').placeholder = network.paired ? 'Mã đã lưu — để trống nếu không đổi' : 'Hub tạo mã, Worker dán cùng mã';
  renderHubMonitor();
}

function render() {
  // Opening A should immediately expose the controls for the useful Page.
  // Prefer an online Page that already has a ready source item.
  if (!selectionInitialized && (!selectedId || !state.bots.some(bot => bot.id === selectedId))) {
    selectedId = state.bots.find(bot => bot.status === 'online' && bot.sourceInventory?.some(job => job.status === 'ready'))?.id
      || state.bots.find(bot => bot.status === 'online' && bot.sourceInventory?.length)?.id
      || state.bots.find(bot => bot.status === 'online')?.id
      || state.bots[0]?.id
      || null;
    selectionInitialized = true;
  }
  const online = state.bots.filter(bot => bot.status === 'online').length;
  const networkLabel = state.network?.mode === 'hub'
    ? ` · Hub: ${(state.hubMachines || []).length} máy Worker`
    : state.network?.mode === 'worker' ? ' · Worker đang báo cáo về Hub' : '';
  $('#connection-summary').textContent = `${online}/${state.bots.length} Page online · bấm một hàng để chỉnh sửa nguồn và lịch.${networkLabel}`;
  $('#app-version').textContent = `v${state.updates?.version || '—'}`;
  $('#bot-rows').innerHTML = state.bots.map(bot => {
    const log = latestLog(bot.id);
    const profileLabel = bot.id;
    const assignedNumber = profileNumber(bot);
    const profileId = assignedNumber ? `<small class="profile-id">Số Profile: ${assignedNumber}</small>` : '';
    const scheduled = hasPostingSchedule(bot);
    const scheduleState = `<span class="schedule-state ${scheduled ? 'active' : 'empty'}">${scheduled ? 'Có lịch đăng' : 'Chưa có lịch đăng'}</span>`;
    return `<tr data-id="${bot.id}" class="${bot.id === selectedId ? 'selected' : ''}">
      <td><strong>${profileLabel}</strong>${profileId}</td><td><span class="status ${bot.status}">${bot.status === 'online' ? 'Online' : 'Offline'}</span><br>${scheduleState}</td>
      <td>${bot.page.name}</td><td>${bot.page.followers.toLocaleString('vi-VN')}</td><td>${bot.page.publishedPosts}</td>
      <td>${scheduled ? `${bot.schedule.postsPerDay} bài/ngày · ${bot.schedule.times.slice(0, 2).join(', ')}${bot.schedule.times.length > 2 ? '…' : ''}${bot.schedule.repeatDaily === false ? '' : ' · hằng ngày'}` : scheduleState}</td>
      <td><span class="source">${bot.sourceFolder || 'Chưa nhập thư mục'}</span></td><td class="${log?.level === 'error' ? 'error' : 'success'}">${log?.message || 'Chưa có log'}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#bot-rows tr').forEach(row => row.addEventListener('click', () => select(row.dataset.id)));
  renderAdsPowerSetup();
  renderNotificationSetup();
  renderNetworkSetup();
  if (selectedId) renderDetail(state.bots.find(bot => bot.id === selectedId));
  else $('#details').hidden = true;
}

function renderDetail(bot) {
  const log = latestLog(bot.id);
  $('#details').hidden = false;
  $('#bot-title').textContent = `${bot.id} · ${bot.page.name}`;
  $('#bot-state').textContent = `${bot.status === 'online' ? 'Online' : 'Offline'} · Lần thấy gần nhất: ${time(bot.lastSeenAt)}`;
  $('#latest-log').textContent = `Log: ${log?.message || 'Chưa có'}`;
  // Không ghi đè dữ liệu khi người dùng đang sửa nguồn hoặc giờ đăng.
  if (!configDirty) {
    $('#source-folder').value = bot.sourceFolder || '';
    $('#page-url').value = bot.pageUrl || bot.page?.url || '';
    $('#posts-per-day').value = bot.schedule.postsPerDay;
    $('#schedule-times').value = bot.schedule.times.join(', ');
    $('#repeat-daily').checked = bot.schedule.repeatDaily !== false;
  }
  $('#source-status').textContent = bot.sourceCheck?.detail
    ? `${bot.sourceCheck.status === 'ready' ? '✓' : '⚠'} ${bot.sourceCheck.detail} · ${time(bot.sourceCheck.checkedAt)}`
    : 'Chưa nhập thư mục nguồn.';
  renderSelectedTimeChips(configDirty ? $('#schedule-times').value : bot.schedule.times);
  $('#followers').textContent = bot.page.followers.toLocaleString('vi-VN');
  $('#published-posts').textContent = bot.page.publishedPosts;
  const ready = (bot.sourceInventory || []).filter(job => job.status === 'ready').length;
  const daily = Math.min(ready, bot.schedule.postsPerDay);
  $('#toggle-upcoming').textContent = ready ? `${ready} video · bấm để xem` : 'Không có video chờ';
  $('#toggle-upcoming').disabled = !ready;
  $('#page-updated').textContent = time(bot.page.updatedAt);
  const recentPublished = [
    ...(bot.recentPublished || []),
    ...Object.values(bot.postOutcomes || {}).filter(outcome => outcome?.status === 'published').map(outcome => ({ postId: outcome.postId, at: outcome.at })),
    ...(bot.sourceInventory || []).filter(job => job.status === 'published' && (job.publishedAt || job.updatedAt)).map(job => ({ postId: job.postId, at: job.publishedAt || job.updatedAt }))
  ].filter(item => item?.at).sort((first, second) => Date.parse(second.at) - Date.parse(first.at));
  const latestPublished = recentPublished[0];
  $('#last-published-at').textContent = latestPublished ? time(latestPublished.at) : (Number(bot.page.publishedPosts) ? `${bot.page.publishedPosts} Reel đã có, chưa lưu thời gian cũ` : 'Chưa có Page xác nhận');
  renderUpcomingList(bot);
  const progress = $('#progress-log');
  progress.innerHTML = '';
  const logs = state.logs.filter(item => item.botId === bot.id).slice(0, 8);
  if (!logs.length) {
    const item = document.createElement('li');
    item.textContent = 'Chưa có thao tác.';
    progress.append(item);
  }
  logs.forEach(item => {
    const row = document.createElement('li');
    const at = document.createElement('time');
    at.textContent = time(item.at);
    const message = document.createElement('span');
    message.className = item.level === 'error' ? 'error' : 'success';
    message.textContent = item.message;
    row.append(at, message);
    progress.append(row);
  });
}

function renderUpcomingList(bot) {
  const panel = $('#upcoming-list-panel');
  const list = $('#upcoming-list');
  const ready = (bot.sourceInventory || []).filter(job => job.status === 'ready');
  const slots = upcomingScheduleSlots(bot, ready.length);
  panel.hidden = !upcomingExpanded;
  list.innerHTML = ready.map((job, index) => `<li><span class="upcoming-index">${index + 1}</span><div><strong>${job.title || job.postId}</strong><small>${job.mediaPath ? job.mediaPath.split(/[\\/]/).pop() : job.postId}</small></div><time>${slots[index] || 'Chưa có lịch'}</time></li>`).join('') || '<li>Không có video chờ.</li>';
  const toggle = () => { upcomingExpanded = !upcomingExpanded; renderUpcomingList(bot); };
  $('#toggle-upcoming').onclick = toggle;
  $('#hide-upcoming').onclick = toggle;
}

function select(id) {
  if (selectedId === id) {
    selectedId = null;
    upcomingExpanded = false;
  } else {
    selectedId = id;
    upcomingExpanded = false;
  }
  selectionInitialized = true;
  configDirty = false;
  adsBindingDirty = false;
  render();
}

async function reload() { state = await request('/api/state'); render(); }

setupCustomTimeSelectors();
updateAppClock();
setInterval(updateAppClock, 1000);

function showAdsResult(message, isError = false) {
  const target = $('#ads-result');
  target.textContent = message;
  target.className = isError ? 'action-result error' : 'action-result';
}

$('#toggle-adspower').addEventListener('click', () => {
  const panel = $('#adspower-setup');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderAdsPowerSetup();
});

function showTelegramResult(message, isError = false) {
  const target = $('#telegram-result');
  target.textContent = message;
  target.className = isError ? 'action-result error' : 'action-result';
}

$('#toggle-telegram').addEventListener('click', () => {
  const panel = $('#telegram-setup');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderNotificationSetup();
});

$('#toggle-network').addEventListener('click', () => {
  const panel = $('#network-setup');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderNetworkSetup();
});

function showNetworkResult(message, isError = false) {
  const target = $('#network-result');
  target.textContent = message;
  target.className = isError ? 'action-result error' : 'action-result';
}

function showUpdateNotice(message, isError = false) {
  const target = $('#update-notice');
  target.textContent = message;
  target.className = isError ? 'update-notice error' : 'update-notice';
}

async function applyGitHubUpdate() {
  const button = $('#update-tool');
  try {
    button.disabled = true;
    showUpdateNotice('Đang kiểm tra cập nhật…');
    const result = await request('/api/update/github-apply', { method: 'POST', body: '{}' });
    state.updates = result.updates;
    $('#app-version').textContent = `v${result.version}`;
    showUpdateNotice(result.changed?.length
      ? `Đã cập nhật ${result.changed.length} tệp. Đóng rồi mở lại ÊU Auto để dùng bản mới.`
      : `Đang sử dụng phiên bản mới nhất.`);
  } catch (error) {
    showUpdateNotice(`Không cập nhật được: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

['network-mode', 'network-machine-name', 'network-hub-url', 'network-shared-key'].forEach(id => {
  ['input', 'change'].forEach(event => $(`#${id}`).addEventListener(event, () => {
    networkSettingsDirty = true;
    $('#network-setup').dataset.mode = $('#network-mode').value;
  }));
});

$('#network-save').addEventListener('click', async () => {
  const button = $('#network-save');
  try {
    button.disabled = true;
    showNetworkResult('Đang lưu cấu hình nhiều máy…');
    const result = await request('/api/network/config', {
      method: 'PUT',
      body: JSON.stringify({
        mode: $('#network-mode').value,
        machineName: $('#network-machine-name').value.trim(),
        hubUrl: $('#network-hub-url').value.trim(),
        sharedKey: $('#network-shared-key').value.trim()
      })
    });
    state.network = result.network;
    // Keep a newly generated Hub key visible until the user has copied it to
    // the Worker machines. Existing keys are never returned by the API.
    networkSettingsDirty = Boolean(result.pairingKey);
    if (result.pairingKey) $('#network-shared-key').value = result.pairingKey;
    showNetworkResult(result.network.mode === 'hub'
      ? `Đã bật A Trung tâm${result.network.hubUrls?.length ? ` tại ${result.network.hubUrls[0]}` : ''}. Sao chép mã ghép nối để nhập vào các máy Worker.`
      : result.network.mode === 'worker'
        ? (result.report?.ok === false ? `Đã lưu nhưng Hub chưa nhận được: ${result.report.error}` : 'Đã lưu Worker và gửi báo cáo đầu tiên về Hub.')
        : 'Tool đang chạy độc lập.');
    await reload();
  } catch (error) {
    showNetworkResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#network-new-key').addEventListener('click', async () => {
  try {
    const result = await request('/api/network/new-key', { method: 'POST', body: '{}' });
    $('#network-shared-key').value = result.sharedKey;
    state.network = result.network;
    networkSettingsDirty = true;
    showNetworkResult('Đã tạo mã mới. Sao chép mã này sang Worker, rồi bấm Lưu kết nối trên Worker.');
  } catch (error) {
    showNetworkResult(error.message, true);
  }
});

$('#network-test').addEventListener('click', async () => {
  try {
    showNetworkResult('Đang kiểm tra kết nối…');
    const result = await request('/api/network/test', { method: 'POST', body: '{}' });
    showNetworkResult(result.message || 'Kết nối thành công.');
    await reload();
  } catch (error) {
    showNetworkResult(error.message, true);
  }
});

$('#network-ai-summary').addEventListener('click', async () => {
  const button = $('#network-ai-summary');
  try {
    button.disabled = true;
    showNetworkResult('AI đang đọc log chung của các máy…');
    const result = await request('/api/network/ai-summary', { method: 'POST', body: '{}' });
    state.hubAiAnalysis = { text: result.analysis, at: result.at };
    showNetworkResult(`AI đã đọc lỗi chung:\n${result.analysis}`);
    renderHubMonitor();
  } catch (error) {
    showNetworkResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

async function applyNetworkUpdate() {
  const mode = state?.network?.mode;
  if (mode !== 'worker') {
    $('#network-setup').hidden = false;
    showNetworkResult(mode === 'hub' ? 'Hub đang là nguồn cập nhật hiện hành. Worker sẽ lấy bản từ Hub này.' : 'Hãy đặt máy này là Worker và nhập địa chỉ Hub trước.', true);
    return;
  }
  try {
    $('#network-setup').hidden = false;
    showNetworkResult('Đang tải bản mới từ Hub…');
    const result = await request('/api/network/update/apply', { method: 'POST', body: '{}' });
    showNetworkResult(result.changed?.length
      ? `Đã cập nhật ${result.changed.length} tệp lên bản ${result.version}. Đóng và mở lại Tool A để dùng bản mới.`
      : `Tool đã là bản mới nhất (${result.version}).`);
  } catch (error) {
    showNetworkResult(error.message, true);
  }
}

$('#network-apply-update').addEventListener('click', applyNetworkUpdate);
$('#update-tool').addEventListener('click', applyGitHubUpdate);

['telegram-token', 'telegram-chat-id', 'telegram-enabled', 'ai-api-key', 'ai-model', 'ai-enabled'].forEach(id => {
  ['input', 'change'].forEach(event => $(`#${id}`).addEventListener(event, () => { notificationSettingsDirty = true; }));
});

$('#telegram-find-chat').addEventListener('click', async () => {
  const token = $('#telegram-token').value.trim();
  if (!token) return showTelegramResult('Hãy dán Bot Token trước, sau đó mở bot trên Telegram và bấm Start.', true);
  const button = $('#telegram-find-chat');
  try {
    button.disabled = true;
    showTelegramResult('Đang tìm Chat ID…');
    const result = await request('/api/notifications/find-chat', { method: 'POST', body: JSON.stringify({ telegramToken: token }) });
    $('#telegram-chat-id').value = result.chatId;
    notificationSettingsDirty = true;
    showTelegramResult(`Đã lấy Chat ID${result.chatName ? ` của ${result.chatName}` : ''}. Bấm “Lưu thiết lập” để hoàn tất.`);
  } catch (error) {
    showTelegramResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#telegram-save').addEventListener('click', async () => {
  const button = $('#telegram-save');
  try {
    button.disabled = true;
    showTelegramResult('Đang lưu thiết lập AI Agent & Telegram…');
    const result = await request('/api/notifications/config', {
      method: 'PUT',
      body: JSON.stringify({
        telegramToken: $('#telegram-token').value.trim(),
        telegramChatId: $('#telegram-chat-id').value.trim(),
        telegramEnabled: $('#telegram-enabled').checked,
        aiApiKey: $('#ai-api-key').value.trim(),
        aiModel: $('#ai-model').value.trim(),
        aiEnabled: $('#ai-enabled').checked
      })
    });
    state.notifications = result.notifications;
    notificationSettingsDirty = false;
    renderNotificationSetup();
    showTelegramResult('Đã lưu. Bấm “Gửi thử” để kiểm tra Telegram.');
  } catch (error) {
    $('#telegram-status').textContent = 'Thiết lập lỗi';
    $('#telegram-status').className = 'ads-status error';
    showTelegramResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#telegram-test').addEventListener('click', async () => {
  try {
    showTelegramResult('Đang gửi tin thử…');
    await request('/api/notifications/test', { method: 'POST', body: '{}' });
    showTelegramResult('Đã gửi tin thử đến Telegram.');
  } catch (error) {
    showTelegramResult(error.message, true);
  }
});

$('#telegram-summary').addEventListener('click', async () => {
  try {
    showTelegramResult('AI Agent đang tổng hợp báo cáo…');
    await request('/api/notifications/daily-summary', { method: 'POST', body: '{}' });
    showTelegramResult('Đã gửi báo cáo tổng hợp đến Telegram.');
  } catch (error) {
    showTelegramResult(error.message, true);
  }
});

['ads-base-url', 'ads-api-key', 'ads-window-width', 'ads-window-height', 'ads-window-columns'].forEach(id => $("#" + id).addEventListener('input', () => { adsSettingsDirty = true; }));
$('#ads-window-layout-enabled').addEventListener('change', () => { adsSettingsDirty = true; });
$('#ads-profile-number').addEventListener('input', () => { adsBindingDirty = true; });

$('#ads-connect').addEventListener('click', async () => {
  try {
    $('#ads-connect').disabled = true;
    showAdsResult('Đang kiểm tra kết nối AdsPower…');
    const result = await request('/api/adspower/config', {
      method: 'PUT',
      body: JSON.stringify({
        baseUrl: $('#ads-base-url').value.trim(),
        apiKey: $('#ads-api-key').value.trim(),
        windowLayout: {
          enabled: $('#ads-window-layout-enabled').checked,
          width: Number($('#ads-window-width').value),
          height: Number($('#ads-window-height').value),
          columns: Number($('#ads-window-columns').value)
        }
      })
    });
    adsSettingsDirty = false;
    $('#ads-api-key').value = '';
    state.adsPower = result.adsPower;
    renderAdsPowerSetup();
    showAdsResult('Đã kiểm tra kết nối AdsPower. Nhập Số Profile để gán cho Page.');
  } catch (error) {
    $('#adspower-status').textContent = 'Kết nối lỗi';
    $('#adspower-status').className = 'ads-status error';
    showAdsResult(error.message, true);
  } finally {
    $('#ads-connect').disabled = false;
  }
});

$('#ads-bind').addEventListener('click', async () => {
  const profileNumberValue = $('#ads-profile-number').value.trim();
  if (!selectedId || !/^\d+$/.test(profileNumberValue)) return showAdsResult('Hãy nhập Số Profile AdsPower (chỉ gồm chữ số).', true);
  try {
    await request(`/api/bots/${encodeURIComponent(selectedId)}/adspower`, {
      method: 'POST',
      body: JSON.stringify({ profileNumber: profileNumberValue })
    });
    adsBindingDirty = false;
    showAdsResult(`Đã gán Số Profile ${profileNumberValue} cho ${selectedId}.`);
    await reload();
  } catch (error) {
    showAdsResult(error.message, true);
  }
});

$('#ads-open').addEventListener('click', async () => {
  if (!selectedId) return showAdsResult('Chưa chọn Page để mở Profile.', true);
  try {
    await request(`/api/bots/${encodeURIComponent(selectedId)}/adspower-start`, { method: 'POST', body: '{}' });
    showAdsResult('A đã gửi lệnh mở Profile AdsPower. Chờ Page kết nối về A.');
    await reload();
  } catch (error) {
    showAdsResult(error.message, true);
  }
});

$('#choose-source-folder').addEventListener('click', async () => {
  const button = $('#choose-source-folder');
  try {
    button.disabled = true;
    $('#action-result').textContent = 'Đang mở hộp chọn thư mục…';
    const result = await request('/api/select-source-folder', { method: 'POST', body: '{}' });
    if (result.canceled) {
      $('#action-result').textContent = 'Chưa chọn thư mục nguồn.';
      return;
    }
    $('#source-folder').value = result.folder || '';
    configDirty = true;
    $('#source-status').textContent = 'Đã chọn thư mục. Bấm “Lưu nguồn & lịch” để A quét video và tiêu đề.';
    $('#action-result').textContent = 'Đã chọn thư mục nguồn.';
  } catch (error) {
    $('#action-result').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#delete-bot').addEventListener('click', async () => {
  const bot = selectedBot();
  if (!bot) return;
  const note = bot.status === 'online'
    ? `${bot.id} đang online. Xóa Page này khỏi A? Extension sẽ không tự thêm lại, trừ khi bạn bấm Kết nối thủ công.`
    : `Xóa ${bot.id} khỏi A? Lịch đăng, nguồn và log của Page này sẽ bị gỡ khỏi A.`;
  if (!window.confirm(note)) return;
  try {
    await request(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE' });
    selectedId = null;
    configDirty = false;
    $('#action-result').textContent = `Đã xóa ${bot.id} khỏi A.`;
    await reload();
  } catch (error) {
    $('#action-result').textContent = error.message;
  }
});

$('#save-config').addEventListener('click', async () => {
  const times = $('#schedule-times').value.split(',').map(value => value.trim()).filter(Boolean);
  await request(`/api/bots/${selectedId}/config`, { method: 'PUT', body: JSON.stringify({ sourceFolder: $('#source-folder').value.trim(), pageUrl: $('#page-url').value.trim(), schedule: { postsPerDay: Number($('#posts-per-day').value), times, repeatDaily: $('#repeat-daily').checked } }) });
  configDirty = false;
  $('#action-result').textContent = 'Đã lưu và A đã tự đồng bộ nguồn từ thư mục.';
  await reload();
});

['source-folder', 'page-url', 'posts-per-day', 'schedule-times', 'repeat-daily'].forEach(id => {
  const field = $(`#${id}`);
  const markDirty = () => {
    configDirty = true;
    if (id === 'schedule-times') renderSelectedTimeChips(field.value);
  };
  field.addEventListener('input', markDirty);
  field.addEventListener('change', markDirty);
});

$('#add-custom-time').addEventListener('click', () => {
  const customTime = `${$('#custom-hour').value}:${$('#custom-minute').value}`;
  const values = parseScheduleTimes([...parseScheduleTimes($('#schedule-times').value), customTime]);
  $('#schedule-times').value = values.join(', ');
  $('#posts-per-day').value = values.length;
  configDirty = true;
  renderSelectedTimeChips(values);
});

$('#clear-times').addEventListener('click', () => {
  $('#schedule-times').value = '';
  $('#posts-per-day').value = 1;
  configDirty = true;
  renderSelectedTimeChips([]);
});

document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', async () => {
  try {
    if (button.dataset.command === 'check_source') {
      const result = await request('/api/source-preview', { method: 'POST', body: JSON.stringify({ sourceFolder: $('#source-folder').value.trim() }) });
      const detail = result.valid
        ? `✓ Đúng định dạng: đã đọc ${result.videoCount} video; ${result.fileTitleCount || result.titleCount} tiêu đề từ ${result.titleFile}${result.filenameTitleCount ? `, ${result.filenameTitleCount} tiêu đề lấy từ tên file video` : ''}.`
        : `⚠ Đã đọc ${result.videoCount} video nhưng mới có ${result.titleCount}/${result.videoCount} tiêu đề. Thiếu: ${result.missingTitles.join(', ') || 'titles.txt/title.txt'}`;
      $('#source-status').textContent = detail;
      $('#action-result').textContent = result.valid ? 'Nguồn đăng bài hợp lệ.' : 'Nguồn chưa đủ tiêu đề cho tất cả video.';
      return;
    }
    if (button.dataset.command === 'post_next' && !window.confirm(`Đăng ngay video ready đầu tiên của ${selectedId}? Lịch đăng các video tiếp theo vẫn được giữ nguyên.`)) return;
    const result = await request(`/api/bots/${selectedId}/commands`, { method: 'POST', body: JSON.stringify({ type: button.dataset.command }) });
    $('#action-result').textContent = button.dataset.command === 'post_next'
      ? (result.adspowerOpened ? `Đã mở AdsPower Số Profile ${result.profileNumber} và đưa video vào hàng chờ. Page sẽ đăng khi Profile kết nối; lịch tiếp theo không đổi.` : 'Đã gửi lệnh đăng ngay video ready đầu tiên. Các lịch đăng tiếp theo không thay đổi.')
      : 'Đã gửi lệnh cho Page. Kết quả sẽ xuất hiện trong log.';
    await reload();
  } catch (error) {
    $('#action-result').textContent = `Không gửi được lệnh: ${error.message}`;
  }
}));

$('#refresh-all').addEventListener('click', async () => {
  await Promise.all(state.bots.map(bot => request(`/api/bots/${bot.id}/commands`, { method: 'POST', body: JSON.stringify({ type: 'refresh_page' }) })));
  await reload();
});

reload().catch(error => $('#connection-summary').textContent = `Không kết nối được A: ${error.message}`);
setInterval(() => reload().catch(() => {}), 3000);
