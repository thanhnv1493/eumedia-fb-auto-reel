const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID, createHash, randomBytes } = require('crypto');

const ROOT = __dirname;
const SEED_DATA_FILE = path.join(ROOT, 'data', 'store.json');
const DATA_DIRECTORY = process.env.A_DATA_DIRECTORY || (process.versions.electron
  ? path.join(process.env.APPDATA || ROOT, 'A Posting Control')
  : path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIRECTORY, 'store.json');
const BACKUP_DATA_FILE = path.join(DATA_DIRECTORY, 'store.last-good.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DISTRIBUTION_ROOT = path.resolve(ROOT, '..', '..');
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm', '.jpg', '.jpeg', '.png']);
const RELEASE_VERSION = '2026.08.06.7';
const GITHUB_UPDATE_REPOSITORY = 'thanhnv1493/eumedia-fb-auto-reel';
const NETWORK_MODES = new Set(['standalone', 'hub', 'worker']);

if (!fs.existsSync(DATA_DIRECTORY)) fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(SEED_DATA_FILE, DATA_FILE);

// Older test builds wrote some Vietnamese text as Windows-1252/Latin-1
// mojibake (for example "ÄÃ£ Ä‘Äƒng"). Repair only strings with those
// distinctive byte patterns and persist the cleaned value once.
function repairLegacyText(value) {
  if (typeof value === 'string') {
    if (!/(?:Ã|Â|Æ|áº|á»|â[€†œ])/u.test(value)) return { value, changed: false };
    const windows1252 = new Map([[0x20AC, 0x80], [0x201A, 0x82], [0x192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x2C6, 0x88], [0x2030, 0x89], [0x160, 0x8A], [0x2039, 0x8B], [0x152, 0x8C], [0x17D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x2DC, 0x98], [0x2122, 0x99], [0x161, 0x9A], [0x203A, 0x9B], [0x153, 0x9C], [0x17E, 0x9E], [0x178, 0x9F]]);
    const bytes = Buffer.from([...value].map(character => String.fromCharCode(windows1252.get(character.codePointAt(0)) ?? (character.codePointAt(0) <= 0xFF ? character.codePointAt(0) : 0x3F))).join(''), 'latin1');
    const repaired = bytes.toString('utf8');
    return repaired.includes('\uFFFD') ? { value, changed: false } : { value: repaired, changed: repaired !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    value.forEach((item, index) => {
      const result = repairLegacyText(item);
      value[index] = result.value;
      changed ||= result.changed;
    });
    return { value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    Object.keys(value).forEach(key => {
      const result = repairLegacyText(value[key]);
      value[key] = result.value;
      changed ||= result.changed;
    });
    return { value, changed };
  }
  return { value, changed: false };
}

function readJsonStore(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) throw new Error('Store file is empty');
  return JSON.parse(raw);
}

function replaceStoreFile(store) {
  const temporary = path.join(DATA_DIRECTORY, `store.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporary, DATA_FILE);
  // Keep a completed, parseable snapshot separate from the active file.  This
  // survives an interrupted save or an unexpected computer shutdown.
  fs.copyFileSync(DATA_FILE, BACKUP_DATA_FILE);
}

function recoverStore(readError) {
  let store;
  let source = 'bản dữ liệu mới';
  try {
    store = readJsonStore(BACKUP_DATA_FILE);
    source = 'bản sao lưu an toàn';
  } catch (_) {
    store = readJsonStore(SEED_DATA_FILE);
  }
  // Do not silently discard a non-empty damaged file.  It can be inspected or
  // recovered later, while an empty/corrupt active file is replaced safely.
  try {
    if (fs.existsSync(DATA_FILE) && fs.statSync(DATA_FILE).size > 0) {
      fs.copyFileSync(DATA_FILE, path.join(DATA_DIRECTORY, `store.corrupt-${Date.now()}.json`));
    }
  } catch (_) {}
  replaceStoreFile(store);
  console.warn(`A restored its data from ${source}: ${readError.message}`);
  return store;
}

function readStore() {
  let store;
  try {
    store = readJsonStore(DATA_FILE);
  } catch (error) {
    store = recoverStore(error);
  }
  const repaired = repairLegacyText(store);
  let storeChanged = repaired.changed;
  store.adsPower = {
    baseUrl: 'http://local.adspower.net:50325',
    apiKey: '',
    windowLayout: { enabled: true, width: 960, height: 540, columns: 2, gap: 8 },
    ...(store.adsPower || {})
  };
  store.adsPower.windowLayout = normalizeAdsPowerWindowLayout(store.adsPower.windowLayout);
  store.notifications = {
    telegram: { botToken: '', chatId: '', enabled: false, ...((store.notifications || {}).telegram || {}) },
    ai: { apiKey: '', model: 'gpt-5.6-terra', enabled: false, ...((store.notifications || {}).ai || {}) }
  };
  store.network = {
    mode: 'standalone',
    machineId: `machine-${randomBytes(5).toString('hex')}`,
    machineName: os.hostname() || 'Máy chưa đặt tên',
    hubUrl: '',
    sharedKey: '',
    ...((store.network || {}))
  };
  // GitHub is the default distribution channel.  The repository is public so
  // the update check never needs to keep a GitHub password or token on a
  // customer's computer.
  store.updates = {
    githubRepo: GITHUB_UPDATE_REPOSITORY,
    githubBranch: 'main',
    githubDirectory: 'eumedia-update',
    lastCheckedAt: '',
    lastError: '',
    ...((store.updates || {}))
  };
  store.updates.githubRepo = String(store.updates.githubRepo || GITHUB_UPDATE_REPOSITORY).trim() || GITHUB_UPDATE_REPOSITORY;
  store.updates.githubBranch = String(store.updates.githubBranch || 'main').trim() || 'main';
  store.updates.githubDirectory = 'eumedia-update';
  if (!NETWORK_MODES.has(store.network.mode)) store.network.mode = 'standalone';
  store.network.machineName = String(store.network.machineName || os.hostname() || 'Máy chưa đặt tên').slice(0, 80);
  store.network.hubUrl = String(store.network.hubUrl || '').trim().replace(/\/$/, '');
  store.hubMachines = (store.hubMachines && typeof store.hubMachines === 'object') ? store.hubMachines : {};
  if (migratePageIdentities(store)) storeChanged = true;
  store.deletedBots = [...new Set((Array.isArray(store.deletedBots) ? store.deletedBots : [])
    .map(canonicalBotId)
    .filter(Boolean))];
  const now = Date.now();
  let historyChanged = false;
  store.bots.forEach(bot => {
    bot.schedule = { postsPerDay: 1, times: ['09:00'], repeatDaily: true, ...(bot.schedule || {}) };
    if (!bot.lastSeenAt || now - new Date(bot.lastSeenAt).getTime() > 45_000) bot.status = 'offline';
    if (hydratePublishedHistory(bot)) historyChanged = true;
  });
  if (historyChanged || storeChanged) writeStore(store);
  return store;
}

function writeStore(store) {
  replaceStoreFile(store);
  queueHubReport();
}

function adsPowerPublic(config) {
  return {
    baseUrl: config?.baseUrl || 'http://local.adspower.net:50325',
    configured: Boolean(config?.apiKey),
    warmupMinutes: 1,
    windowLayout: normalizeAdsPowerWindowLayout(config?.windowLayout)
  };
}

function normalizeAdsPowerWindowLayout(layout = {}) {
  const value = layout || {};
  return {
    enabled: value.enabled !== false,
    width: Math.max(480, Math.min(3840, Number(value.width) || 960)),
    height: Math.max(360, Math.min(2160, Number(value.height) || 540)),
    columns: Math.max(1, Math.min(6, Number(value.columns) || 2)),
    gap: Math.max(0, Math.min(80, Number.isFinite(Number(value.gap)) ? Number(value.gap) : 8))
  };
}

function notificationsPublic(config) {
  return {
    telegram: {
      configured: Boolean(config?.telegram?.botToken && config?.telegram?.chatId),
      enabled: Boolean(config?.telegram?.enabled),
      chatId: config?.telegram?.chatId ? String(config.telegram.chatId).slice(-4).padStart(String(config.telegram.chatId).length, '•') : ''
    },
    ai: {
      configured: Boolean(config?.ai?.apiKey),
      enabled: Boolean(config?.ai?.enabled),
      model: config?.ai?.model || 'gpt-5.6-terra'
    }
  };
}

function networkPublic(config) {
  const network = config || {};
  const hubUrls = NETWORK_MODES.has(network.mode) && network.mode === 'hub'
    ? Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal)
      .map(item => `http://${item.address}:${Number(process.env.PORT || 3000)}`)
    : [];
  return {
    mode: NETWORK_MODES.has(network.mode) ? network.mode : 'standalone',
    machineId: String(network.machineId || ''),
    machineName: String(network.machineName || ''),
    hubUrl: String(network.hubUrl || ''),
    paired: Boolean(network.sharedKey),
    version: RELEASE_VERSION,
    hubUrls
  };
}

function updatesPublic(config) {
  const updates = config || {};
  return {
    githubRepo: String(updates.githubRepo || ''),
    githubBranch: String(updates.githubBranch || 'main'),
    configured: Boolean(updates.githubRepo),
    lastCheckedAt: String(updates.lastCheckedAt || ''),
    lastError: String(updates.lastError || ''),
    version: RELEASE_VERSION
  };
}

function publicStore(store) {
  const safe = JSON.parse(JSON.stringify(store));
  safe.adsPower = adsPowerPublic(store.adsPower);
  safe.notifications = notificationsPublic(store.notifications);
  safe.network = networkPublic(store.network);
  safe.updates = updatesPublic(store.updates);
  safe.hubMachines = Object.values(store.hubMachines || {}).map(machine => ({
    machineId: machine.machineId,
    machineName: machine.machineName,
    version: machine.version,
    lastSeenAt: machine.lastSeenAt,
    receivedAt: machine.receivedAt,
    pages: machine.pages || [],
    errors: machine.errors || []
  })).sort((first, second) => String(first.machineName || '').localeCompare(String(second.machineName || '')));
  return safe;
}

function adsPowerBaseUrl(value) {
  const url = new URL(String(value || '').trim() || 'http://local.adspower.net:50325');
  if (!/^https?:$/.test(url.protocol)) throw new Error('Địa chỉ AdsPower phải bắt đầu bằng http:// hoặc https://');
  return url.toString().replace(/\/$/, '');
}

function adsPowerRequest(config, pathname, { method = 'GET', payload } = {}) {
  if (!config?.apiKey) throw new Error('Chưa nhập API key AdsPower');
  const target = new URL(pathname, adsPowerBaseUrl(config.baseUrl));
  const text = payload === undefined ? '' : JSON.stringify(payload);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, {
      method,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {})
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        let result;
        try { result = raw ? JSON.parse(raw) : {}; } catch (_) { return reject(new Error('AdsPower trả về dữ liệu không hợp lệ')); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(result.msg || `AdsPower trả về lỗi ${response.statusCode}`));
        if (result.code !== 0) return reject(new Error(result.msg || 'AdsPower không thực hiện được yêu cầu'));
        resolve(result);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Không kết nối được AdsPower trong 15 giây')));
    request.on('error', error => reject(new Error(error.message || 'Không kết nối được AdsPower')));
    if (text) request.write(text);
    request.end();
  });
}

function localJsonRequest(url, { timeout = 8_000 } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, { method: 'GET', timeout }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`cổng AdsPower trả về ${response.statusCode}`);
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Cổng điều khiển AdsPower không phản hồi')));
    request.on('error', error => reject(new Error(error.message || 'Không kết nối được cổng điều khiển AdsPower')));
    request.end();
  });
}

function webSocketFrame(text, opcode = 0x1) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function cdpSession(webSocketUrl) {
  const target = new URL(webSocketUrl);
  if (target.protocol !== 'ws:') return Promise.reject(new Error('Cổng AdsPower không trả về kênh điều khiển hợp lệ'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port || 80) });
    const key = randomBytes(16).toString('base64');
    const pending = new Map();
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    let handshakeComplete = false;
    let resolved = false;
    let closed = false;
    let fragments = [];

    const fail = error => {
      if (closed) return;
      closed = true;
      socket.destroy();
      pending.forEach(({ reject: rejectCommand }) => rejectCommand(error));
      pending.clear();
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    };
    const close = () => {
      if (!socket.destroyed) socket.end();
    };
    const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
      if (closed || socket.destroyed) return rejectCommand(new Error('Kênh điều khiển AdsPower đã đóng'));
      const id = nextId++;
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.write(webSocketFrame(JSON.stringify({ id, method, params })));
    });
    const handleMessage = raw => {
      let message;
      try { message = JSON.parse(raw); } catch (_) { return; }
      if (!message.id || !pending.has(message.id)) return;
      const command = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) return command.reject(new Error(message.error.message || `CDP lỗi ${message.error.code || ''}`));
      command.resolve(message.result || {});
    };
    const consumeFrames = () => {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const opcode = first & 0x0f;
        const final = Boolean(first & 0x80);
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const longLength = buffer.readBigUInt64BE(2);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) return fail(new Error('Phản hồi AdsPower quá lớn'));
          length = Number(longLength);
          offset = 10;
        }
        if (masked) {
          if (buffer.length < offset + 4) return;
          offset += 4;
        }
        if (buffer.length < offset + length) return;
        let payload = buffer.subarray(offset, offset + length);
        if (masked) {
          const maskStart = offset - 4;
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[maskStart + (index % 4)];
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) return fail(new Error('AdsPower đã đóng kênh điều khiển'));
        if (opcode === 0x9) {
          socket.write(webSocketFrame(payload, 0xA));
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          fragments.push(payload);
          if (final) {
            handleMessage(Buffer.concat(fragments).toString('utf8'));
            fragments = [];
          }
        }
      }
    };

    socket.setTimeout(15_000, () => fail(new Error('Cổng điều khiển AdsPower phản hồi quá lâu')));
    socket.once('connect', () => {
      const location = `${target.pathname}${target.search}`;
      socket.write(`GET ${location} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeComplete) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString('utf8');
        if (!/^HTTP\/1\.1 101\b/m.test(header)) return fail(new Error('AdsPower từ chối kênh điều khiển trực tiếp'));
        handshakeComplete = true;
        buffer = buffer.subarray(end + 4);
        resolved = true;
        return resolve({ send, close });
      }
      consumeFrames();
    });
    socket.on('error', error => {
      if (!handshakeComplete) fail(new Error(error.message || 'Không kết nối được cổng điều khiển AdsPower'));
      else pending.forEach(({ reject: rejectCommand }) => rejectCommand(error));
    });
    socket.on('close', () => {
      if (handshakeComplete) pending.forEach(({ reject: rejectCommand }) => rejectCommand(new Error('Kênh điều khiển AdsPower đã đóng')));
    });
  });
}

const cdpDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function uploadFileViaAdsPower(bot, { filePath, pageUrl } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('A không tìm thấy file video cần tải lên');
  const debugPort = Number(bot.adsPower?.debugPort || 0);
  if (!debugPort) throw new Error('Profile AdsPower chưa mở hoặc thiếu cổng điều khiển');
  const targets = await localJsonRequest(`http://127.0.0.1:${debugPort}/json`);
  const pages = (Array.isArray(targets) ? targets : []).filter(target => target.type === 'page' && /(^|\.)facebook\.com\//i.test(target.url || ''));
  const normalized = value => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const wanted = normalized(pageUrl);
  const target = pages.find(item => normalized(item.url) === wanted)
    || pages.find(item => wanted && normalized(item.url).startsWith(wanted))
    || pages[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('A không tìm thấy tab Facebook đang mở của Profile AdsPower');

  const session = await cdpSession(target.webSocketDebuggerUrl);
  try {
    await session.send('DOM.enable');
    let nodeId = 0;
    for (let attempt = 0; attempt < 12 && !nodeId; attempt += 1) {
      const root = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const found = await session.send('DOM.querySelector', {
        nodeId: root.root.nodeId,
        selector: 'input[data-b-upload-target="true"]'
      });
      nodeId = found.nodeId || 0;
      if (!nodeId) await cdpDelay(250);
    }
    if (!nodeId) throw new Error('A chưa thấy ô tải video Facebook do extension đánh dấu');
    await session.send('DOM.focus', { nodeId }).catch(() => {});
    await session.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
    return { ok: true };
  } finally {
    await session.send('DOM.disable').catch(() => {});
    session.close();
  }
}

function jsonRequest(url, { method = 'POST', headers = {}, payload, timeout = 25_000 } = {}) {
  const target = new URL(url);
  const text = payload === undefined ? '' : JSON.stringify(payload);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, {
      method,
      timeout,
      headers: {
        ...(text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {}),
        ...headers
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => raw += chunk);
      response.on('end', () => {
        let result;
        try { result = raw ? JSON.parse(raw) : {}; } catch (_) { return reject(new Error('Dịch vụ trả về dữ liệu không hợp lệ')); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(result.error?.message || result.description || `Dịch vụ trả về lỗi ${response.statusCode}`));
        resolve(result);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Kết nối quá lâu, hãy thử lại')));
    request.on('error', error => reject(new Error(error.message || 'Không kết nối được dịch vụ')));
    if (text) request.write(text);
    request.end();
  });
}

function httpsJsonRequest(url, options = {}) {
  return jsonRequest(url, options);
}

function bufferRequest(url, { headers = {}, timeout = 30_000, redirects = 0 } = {}) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(target, { method: 'GET', timeout, headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error('GitHub chuyển hướng quá nhiều lần'));
        return resolve(bufferRequest(new URL(response.headers.location, target).toString(), { headers, timeout, redirects: redirects + 1 }));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const content = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = content.toString('utf8').slice(0, 400);
          return reject(new Error(detail || `GitHub trả về lỗi ${response.statusCode}`));
        }
        resolve(content);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Kết nối GitHub quá lâu, hãy thử lại')));
    request.on('error', error => reject(new Error(error.message || 'Không kết nối được GitHub')));
    request.end();
  });
}

function normalizeGitHubSettings(input = {}) {
  const githubRepo = String(input.githubRepo || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  const githubBranch = String(input.githubBranch || 'main').trim() || 'main';
  if (githubRepo && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(githubRepo)) {
    throw new Error('Repository GitHub phải có dạng tai-khoan/ten-repository');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(githubBranch)) throw new Error('Tên nhánh GitHub chỉ dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới');
  return { githubRepo, githubBranch, githubDirectory: 'eumedia-update' };
}

function githubRepositoryApiBaseUrl(config) {
  const updates = normalizeGitHubSettings(config);
  if (!updates.githubRepo) throw new Error('Hãy nhập Repository GitHub trước');
  return `https://api.github.com/repos/${updates.githubRepo}/contents/${updates.githubDirectory}`;
}

async function githubRepositoryFile(config, remotePath) {
  const updates = normalizeGitHubSettings(config);
  const safePath = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!safePath || safePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Duong dan tep cap nhat GitHub khong hop le');
  }
  const encodedPath = safePath.split('/').map(encodeURIComponent).join('/');
  const baseUrl = githubRepositoryApiBaseUrl(updates);
  const response = await bufferRequest(`${baseUrl}/${encodedPath}?ref=${encodeURIComponent(updates.githubBranch)}`, {
    headers: { 'User-Agent': 'Eumedia-FB-auto-reel-updater', Accept: 'application/vnd.github+json' },
    timeout: 45_000
  });
  let payload;
  try { payload = JSON.parse(response.toString('utf8')); } catch (_) { throw new Error(`GitHub tra ve du lieu khong hop le cho ${safePath}`); }
  if (!payload || payload.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error(`GitHub khong tim thay tep cap nhat ${safePath}`);
  }
  return Buffer.from(payload.content.replace(/\s/g, ''), 'base64');
}

async function githubUpdateManifest(config) {
  const updates = normalizeGitHubSettings(config);
  const baseUrl = githubRepositoryApiBaseUrl(updates);
  const content = await githubRepositoryFile(updates, 'update-manifest.json');
  let manifest;
  try { manifest = JSON.parse(content.toString('utf8')); } catch (_) { throw new Error('Tệp cập nhật trên GitHub không đúng định dạng'); }
  if (!manifest || !Array.isArray(manifest.files) || !manifest.version) throw new Error('Gói cập nhật GitHub thiếu danh sách tệp');
  return { baseUrl, manifest, updates };
}

function changedUpdateFiles(manifest) {
  const local = new Map(updateManifest().files.map(item => [item.path, item.sha256]));
  return manifest.files.filter(item => validUpdatePath(item.path) && typeof item.sha256 === 'string' && local.get(item.path) !== item.sha256);
}

async function checkGitHubUpdate(store) {
  const { baseUrl, manifest } = await githubUpdateManifest(store.updates);
  const changed = changedUpdateFiles(manifest);
  store.updates.lastCheckedAt = new Date().toISOString();
  store.updates.lastError = '';
  writeStore(store);
  return { version: String(manifest.version), changed: changed.map(item => item.path), available: changed.length > 0, baseUrl };
}

async function applyUpdateFromGitHub(store) {
  const { baseUrl, manifest, updates } = await githubUpdateManifest(store.updates);
  const changed = changedUpdateFiles(manifest);
  for (const item of changed) {
    const remotePath = String(item.remotePath || item.path).replace(/\\/g, '/');
    if (!remotePath || remotePath.includes('..')) throw new Error(`Tệp cập nhật ${item.path} có đường dẫn GitHub không hợp lệ`);
    const content = await githubRepositoryFile(updates, remotePath);
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== item.sha256) throw new Error(`Tệp ${item.path} tải từ GitHub không đúng mã kiểm tra`);
    atomicWriteFile(updateAbsolutePath(item.path), content);
  }
  store.updates.lastCheckedAt = new Date().toISOString();
  store.updates.lastError = '';
  writeStore(store);
  return { version: String(manifest.version), changed: changed.map(item => item.path), restartRequired: changed.length > 0 };
}

function networkBaseUrl(value) {
  const target = new URL(String(value || '').trim());
  if (!/^https?:$/.test(target.protocol)) throw new Error('Địa chỉ Hub phải bắt đầu bằng http:// hoặc https://');
  return target.toString().replace(/\/$/, '');
}

function networkAuthorization(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function networkKeyMatches(expected, supplied) {
  const first = Buffer.from(String(expected || ''));
  const second = Buffer.from(String(supplied || ''));
  return first.length > 0 && first.length === second.length && require('crypto').timingSafeEqual(first, second);
}

function compactWorkerReport(store) {
  const pages = (store.bots || []).map(bot => ({
    id: bot.id,
    name: bot.page?.name || 'Chưa đọc Page',
    status: bot.status || 'offline',
    profileNumber: String(bot.adsPower?.profileNumber || ''),
    ready: (bot.sourceInventory || []).filter(item => item.status === 'ready').length,
    queued: (bot.sourceInventory || []).filter(item => ['queued', 'in_progress'].includes(item.status)).length,
    published: Number(bot.page?.publishedPosts || 0),
    lastSeenAt: bot.lastSeenAt || null,
    lastLog: (store.logs || []).find(log => log.botId === bot.id) || null
  }));
  return {
    machineId: store.network.machineId,
    machineName: store.network.machineName,
    version: RELEASE_VERSION,
    sentAt: new Date().toISOString(),
    pages,
    errors: (store.logs || []).filter(log => log.level === 'error').slice(0, 12)
  };
}

let hubReportTimer = null;
let hubReportInFlight = false;

function queueHubReport() {
  if (hubReportTimer || hubReportInFlight) return;
  hubReportTimer = setTimeout(() => {
    hubReportTimer = null;
    sendHubReport().catch(() => {});
  }, 2_000);
}

async function sendHubReport() {
  if (hubReportInFlight) return { skipped: true };
  const store = readStore();
  const network = store.network || {};
  if (network.mode !== 'worker' || !network.hubUrl || !network.sharedKey) return { skipped: true };
  hubReportInFlight = true;
  try {
    const result = await jsonRequest(`${networkBaseUrl(network.hubUrl)}/api/network/report`, {
      headers: { Authorization: `Bearer ${network.sharedKey}` },
      payload: compactWorkerReport(store),
      timeout: 12_000
    });
    network.lastReportAt = new Date().toISOString();
    network.lastReportError = '';
    replaceStoreFile(store);
    return result;
  } catch (error) {
    network.lastReportError = error.message || 'Không gửi được báo cáo về Hub';
    replaceStoreFile(store);
    return { ok: false, error: network.lastReportError };
  } finally {
    hubReportInFlight = false;
  }
}

function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
}

async function sendTelegram(store, text, { force = false } = {}) {
  const config = store.notifications?.telegram || {};
  if (!config.enabled && !force) return { skipped: true };
  if (!config.botToken || !config.chatId) throw new Error('Chưa nhập đủ Telegram Bot Token và Chat ID');
  const result = await httpsJsonRequest(`https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`, {
    payload: { chat_id: config.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  });
  if (!result.ok) throw new Error(result.description || 'Telegram không gửi được tin nhắn');
  return { skipped: false };
}

async function findTelegramChat(botToken) {
  if (!botToken) throw new Error('Hãy dán Telegram Bot Token trước');
  const result = await httpsJsonRequest(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates`, {
    payload: { allowed_updates: ['message'] }
  });
  if (!result.ok) throw new Error(result.description || 'Telegram không trả về được Chat ID');
  const updates = Array.isArray(result.result) ? result.result.slice().reverse() : [];
  const chat = updates.map(update => update.message?.chat || update.edited_message?.chat || update.channel_post?.chat).find(Boolean);
  if (!chat?.id) throw new Error('Chưa thấy tin nhắn nào. Hãy mở bot trên Telegram, bấm Start hoặc gửi một tin nhắn, rồi thử lại.');
  return { chatId: String(chat.id), chatName: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '' };
}

function outputText(response) {
  if (response.output_text) return String(response.output_text).trim();
  return (response.output || []).flatMap(item => item.content || [])
    .map(item => item.text || item.output_text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function askAiAgent(store, context) {
  const config = store.notifications?.ai || {};
  if (!config.enabled || !config.apiKey) return '';
  const response = await httpsJsonRequest('https://api.openai.com/v1/responses', {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    payload: {
      model: config.model || 'gpt-5.6-terra',
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      instructions: 'Bạn là trợ lý giám sát đăng Facebook Page. Chỉ dùng dữ liệu được đưa vào. Viết tiếng Việt, tối đa 4 gạch đầu dòng: tình trạng, nguyên nhân có thể, việc cần làm tiếp theo. Không nói rằng bạn đã tự sửa lỗi hay thực hiện hành động.',
      input: context,
      max_output_tokens: 260
    }
  });
  return outputText(response);
}

function errorAdvice(error) {
  const message = String(error || '').toLocaleLowerCase('vi-VN');
  if (/captcha|xác minh/.test(message)) return 'Mở Profile để tự xử lý xác minh/CAPTCHA rồi đăng lại.';
  if (/mô tả|caption|tiêu đề|hashtag/.test(message)) return 'Kiểm tra titles.txt/title.txt và ô Mô tả thước phim.';
  if (/nguồn|video|thư mục|file/.test(message)) return 'Kiểm tra đường dẫn nguồn, video và file titles.txt/title.txt.';
  if (/profile|adspower|kết nối/.test(message)) return 'Kiểm tra Số Profile AdsPower và kết nối của Page.';
  return 'Mở Tiến trình thao tác trong A để xem bước lỗi gần nhất rồi thử lại.';
}

function formatPostReport(bot, outcome) {
  const job = (bot.sourceInventory || []).find(item => item.postId === outcome.postId);
  const success = outcome.status === 'published';
  const title = job?.title || outcome.postId;
  const base = [
    `<b>${success ? '✅ Đăng thành công' : '❌ Bài đăng cần kiểm tra'}</b>`,
    `Page: <b>${escapeTelegramHtml(bot.id)}</b>`,
    `Page: <b>${escapeTelegramHtml(bot.page?.name || 'Chưa rõ')}</b>`,
    `Bài: ${escapeTelegramHtml(title)}`,
    `Reel đã đăng: ${Number(bot.page?.publishedPosts) || 0}`
  ];
  if (!success) {
    base.push(`Lỗi: ${escapeTelegramHtml(outcome.error || outcome.status)}`);
    base.push(`Gợi ý: ${escapeTelegramHtml(errorAdvice(outcome.error))}`);
  }
  return base.join('\n');
}

async function notifyPostOutcome(store, bot, outcome) {
  if (!store.notifications?.telegram?.enabled) return { skipped: true };
  let message = formatPostReport(bot, outcome);
  try {
    const ai = await askAiAgent(store, `Dữ liệu tool A:\n${message.replace(/<[^>]+>/g, '')}\nTrạng thái kỹ thuật: ${outcome.status}.`);
    if (ai) message += `\n\n<b>🤖 AI Agent nhận định</b>\n${escapeTelegramHtml(ai)}`;
  } catch (error) {
    message += `\n\nAI Agent chưa phân tích được: ${escapeTelegramHtml(error.message)}`;
  }
  return sendTelegram(store, message);
}

function bangkokDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(value)
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function notifyDailySummary(store, { force = false } = {}) {
  const today = bangkokDate();
  const successes = store.bots.reduce((count, bot) => count + Object.values(bot.confirmedPosts || {}).filter(at => bangkokDate(new Date(at)) === today).length, 0);
  const errors = (store.logs || []).filter(log => log.level === 'error' && bangkokDate(new Date(log.at)) === today);
  let message = [`<b>📊 Báo cáo A — ${today}</b>`, `✅ Bài thành công hôm nay: <b>${successes}</b>`, `❌ Lỗi hôm nay: <b>${errors.length}</b>`, '', '<b>Page đang quản lý</b>'];
  message.push(...store.bots.map(bot => `• ${escapeTelegramHtml(bot.id)} · ${escapeTelegramHtml(bot.page?.name || 'Chưa gán Page')}: ${Number(bot.page?.publishedPosts) || 0} Reel`));
  if (errors.length) message.push('', '<b>Lỗi mới nhất</b>', ...errors.slice(0, 5).map(log => `• ${escapeTelegramHtml(log.message)}`));
  message = message.join('\n');
  try {
    const ai = await askAiAgent(store, `Hãy phân tích báo cáo từ tool A sau và đề xuất ưu tiên xử lý:\n${message.replace(/<[^>]+>/g, '')}`);
    if (ai) message += `\n\n<b>🤖 AI Agent tổng hợp</b>\n${escapeTelegramHtml(ai)}`;
  } catch (error) {
    message += `\n\nAI Agent chưa phân tích được: ${escapeTelegramHtml(error.message)}`;
  }
  return sendTelegram(store, message, { force });
}

async function listAdsPowerProfiles(config) {
  const profiles = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await adsPowerRequest(config, '/api/v2/browser-profile/list', { method: 'POST', payload: { page, limit: 200 } });
    const data = result.data || {};
    profiles.push(...(data.list || []).map(profile => ({
      id: String(profile.profile_id || profile.user_id || ''),
      profileNumber: String(profile.profile_no || profile.serial_number || ''),
      name: String(profile.name || profile.username || profile.profile_no || 'Chưa đặt tên'),
      group: String(profile.group_name || ''),
      platform: String(profile.platform || profile.domain_name || '')
    })).filter(profile => profile.id));
    totalPages = Math.max(1, Number(data.total_pages) || Math.ceil((Number(data.total_count) || profiles.length) / 200));
    page += 1;
  } while (page <= totalPages && page <= 20);
  return profiles;
}

async function activeRecentAdsPowerProfiles(config) {
  // This is a fallback when the browser User-Agent is shared by more than
  // one Profile. The exact User-Agent match above is preferred.
  const profiles = (await listAdsPowerProfiles(config)).filter(profile => profile.profileNumber);
  const active = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, profiles.length) }, async () => {
    while (cursor < profiles.length) {
      const profile = profiles[cursor++];
      try {
        const result = await adsPowerRequest(config, `/api/v2/browser-profile/active?profile_no=${encodeURIComponent(profile.profileNumber)}`);
        const status = String(result.data?.status || result.data?.state || '').toLowerCase();
        if (['active', 'running', 'open', 'opened'].includes(status)) active.push(profile);
      } catch (_) {
        // A single unavailable profile must not stop automatic pairing.
      }
    }
  });
  await Promise.all(workers);
  return active;
}

const normalizeUserAgent = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const waitForAdsPower = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let adsPowerPairingQueue = Promise.resolve();
let adsPowerBrowserActionQueue = Promise.resolve();

function queueAdsPowerPairing(task) {
  const run = adsPowerPairingQueue.then(task, task);
  adsPowerPairingQueue = run.catch(() => {});
  return run;
}

function queueAdsPowerBrowserAction(task) {
  const run = adsPowerBrowserActionQueue
    .catch(() => {})
    .then(async () => {
      try {
        return await task();
      } finally {
        // AdsPower Local API accepts very few browser start/stop commands per
        // second. Keep a gap even after an error so several Pages scheduled
        // for the same minute do not make each other fail.
        await waitForAdsPower(1_150);
      }
    });
  adsPowerBrowserActionQueue = run.catch(() => {});
  return run;
}

async function profilesMatchingBrowserUserAgent(config, browserUserAgent) {
  const expected = normalizeUserAgent(browserUserAgent);
  if (!expected) return [];
  const profiles = (await listAdsPowerProfiles(config)).filter(profile => profile.profileNumber);
  const chunks = Array.from({ length: Math.ceil(profiles.length / 10) }, (_, index) => profiles.slice(index * 10, index * 10 + 10));
  const matches = [];
  let checkedBatches = 0;
  let lastError = null;
  for (const [index, chunk] of chunks.entries()) {
    // AdsPower limits Local API requests per second. Querying one batch at a
    // time is intentional: reliable pairing is more important than speed.
    await waitForAdsPower(1_100);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await adsPowerRequest(config, '/api/v2/browser-profile/ua', {
          method: 'POST',
          payload: { profile_no: chunk.map(profile => profile.profileNumber) }
        });
        checkedBatches += 1;
        const byNumber = new Map(chunk.map(profile => [profile.profileNumber, profile]));
        (result.data?.list || []).forEach(item => {
          const profile = byNumber.get(String(item.profile_no || ''));
          if (profile && normalizeUserAgent(item.ua) === expected) matches.push(profile);
        });
        break;
      } catch (_) {
        lastError = _;
        if (attempt === 0) await waitForAdsPower(1_600);
      }
    }
  }
  if (!checkedBatches && lastError) throw lastError;
  return matches;
}

function bindAdsPowerProfile(bot, profile) {
  bot.adsPower = {
    ...(bot.adsPower || {}),
    profileNumber: profile.profileNumber,
    profileId: profile.id,
    profileName: profile.name,
    boundAt: new Date().toISOString(),
    launchStatus: 'open'
  };
}

async function autoBindActiveAdsPowerProfile(store, bot, browser = {}) {
  if (String(bot.adsPower?.profileNumber || '').trim()) return { status: 'already_bound', profileNumber: bot.adsPower.profileNumber };
  if (!store.adsPower?.apiKey) return { status: 'not_configured' };
  const startupProfileId = String(browser.adsPowerProfileId || '').trim();
  if (startupProfileId) {
    const exactMatches = (await listAdsPowerProfiles(store.adsPower)).filter(profile => profile.id === startupProfileId);
    if (exactMatches.length === 1) {
      const profile = exactMatches[0];
      bindAdsPowerProfile(bot, profile);
      addLog(store, bot.id, `A đã đọc tab AdsPower và tự gán Số Profile ${profile.profileNumber} cho ${bot.id}`, 'success');
      return { status: 'matched', profileNumber: profile.profileNumber, profileName: profile.name, method: 'adspower-tab' };
    }
  }
  const userAgentMatches = await profilesMatchingBrowserUserAgent(store.adsPower, browser.userAgent);
  if (userAgentMatches.length === 1) {
    const profile = userAgentMatches[0];
    bindAdsPowerProfile(bot, profile);
    addLog(store, bot.id, `A đã tự gán AdsPower Số Profile ${profile.profileNumber} theo trình duyệt của ${bot.id}`, 'success');
    return { status: 'matched', profileNumber: profile.profileNumber, profileName: profile.name, method: 'browser' };
  }
  if (String(browser.userAgent || '').trim()) {
    return { status: userAgentMatches.length ? 'ambiguous' : 'not_found', matchedUserAgents: userAgentMatches.length };
  }
  const active = await activeRecentAdsPowerProfiles(store.adsPower);
  if (active.length !== 1) return { status: active.length ? 'ambiguous' : 'not_found', activeCount: active.length, matchedUserAgents: userAgentMatches.length };
  const profile = active[0];
  bindAdsPowerProfile(bot, profile);
  addLog(store, bot.id, `A đã tự gán AdsPower Số Profile ${profile.profileNumber} khi ${bot.id} kết nối`, 'success');
  return { status: 'matched', profileNumber: profile.profileNumber, profileName: profile.name };
}

async function openAdsPowerProfile(store, bot) {
  const profileNumber = String(bot.adsPower?.profileNumber || '').trim();
  if (!profileNumber) return { skipped: true };
  const layout = normalizeAdsPowerWindowLayout(store.adsPower?.windowLayout);
  const orderedBots = [...(store.bots || [])]
    .filter(item => String(item.adsPower?.profileNumber || '').trim())
    .sort((first, second) => Number(String(first.id).replace(/\D/g, '')) - Number(String(second.id).replace(/\D/g, '')));
  const slot = Math.max(0, orderedBots.findIndex(item => item.id === bot.id));
  const column = slot % layout.columns;
  const row = Math.floor(slot / layout.columns);
  const launchArgs = layout.enabled
    ? [
      `--window-size=${layout.width},${layout.height}`,
      `--window-position=${column * (layout.width + layout.gap)},${row * (layout.height + layout.gap)}`
    ]
    : [];
  const result = await queueAdsPowerBrowserAction(() => adsPowerRequest(store.adsPower, '/api/v2/browser-profile/start', {
    method: 'POST',
    payload: {
      profile_no: profileNumber,
      ...(launchArgs.length ? { launch_args: launchArgs } : {})
    }
  }));
  bot.adsPower = {
    ...bot.adsPower,
    launchStatus: 'opening',
    lastOpenedAt: new Date().toISOString(),
    closeAfterAt: null,
    debugPort: result.data?.debug_port || ''
  };
  return result.data || {};
}

async function closeAdsPowerProfile(store, bot) {
  const profileNumber = String(bot.adsPower?.profileNumber || '').trim();
  if (!profileNumber) return { skipped: true };
  await queueAdsPowerBrowserAction(() => adsPowerRequest(store.adsPower, '/api/v2/browser-profile/stop', {
    method: 'POST',
    payload: { profile_no: profileNumber }
  }));
  bot.adsPower = {
    ...bot.adsPower,
    launchStatus: 'closed',
    lastClosedAt: new Date().toISOString(),
    closeAfterAt: null
  };
  return { skipped: false };
}

function canonicalBotId(value) {
  const match = String(value || '').trim().match(/^Page([1-9]\d{0,3})$/i);
  if (!match || Number(match[1]) > 1000) return null;
  return `Page${Number(match[1])}`;
}

function migratePageIdentities(store) {
  if (store.pageIdentityMigration === true) return false;
  const isLegacyId = bot => /^B[1-9]\d{0,3}$/i.test(String(bot.id || ''));
  // Only retain real previous connections. Test rows that have neither an
  // AdsPower profile nor a source must not consume Page3, Page4, ... later.
  const isConfiguredLegacyPage = bot => Boolean(
    String(bot.adsPower?.profileNumber || '').trim()
    || String(bot.sourceFolder || '').trim()
    || String(bot.pageUrl || '').trim()
  );
  const legacyBots = (store.bots || []).filter(bot => isLegacyId(bot) && isConfiguredLegacyPage(bot))
    .sort((first, second) => Number(String(first.id).slice(1)) - Number(String(second.id).slice(1)));
  const discardedLegacyIds = new Set((store.bots || []).filter(bot => isLegacyId(bot) && !isConfiguredLegacyPage(bot)).map(bot => String(bot.id).toUpperCase()));
  const aliases = { ...(store.pageIdAliases || {}) };
  const used = new Set((store.bots || []).map(bot => canonicalBotId(bot.id)).filter(Boolean));
  const renamed = new Map();
  let next = 1;
  legacyBots.forEach(bot => {
    while (used.has(`Page${next}`)) next += 1;
    const oldId = String(bot.id).toUpperCase();
    const newId = `Page${next}`;
    bot.id = newId;
    aliases[oldId] = newId;
    renamed.set(oldId, newId);
    used.add(newId);
    next += 1;
  });
  if (renamed.size) {
    store.logs = (store.logs || []).map(log => ({ ...log, botId: renamed.get(String(log.botId || '').toUpperCase()) || log.botId }));
  }
  if (discardedLegacyIds.size) {
    // Preserve incomplete test connections out of the active dashboard
    // instead of deleting their configuration or history.
    const archivedBots = (store.bots || []).filter(bot => discardedLegacyIds.has(String(bot.id || '').toUpperCase()));
    const archivedLogs = (store.logs || []).filter(log => discardedLegacyIds.has(String(log.botId || '').toUpperCase()));
    store.archivedLegacyPages = [...(store.archivedLegacyPages || []), ...archivedBots];
    store.archivedLegacyLogs = [...(store.archivedLegacyLogs || []), ...archivedLogs];
    store.bots = (store.bots || []).filter(bot => !discardedLegacyIds.has(String(bot.id || '').toUpperCase()));
    store.logs = (store.logs || []).filter(log => !discardedLegacyIds.has(String(log.botId || '').toUpperCase()));
  }
  store.deletedBots = (store.deletedBots || []).map(canonicalBotId).filter(Boolean);
  store.pageIdAliases = aliases;
  store.pageIdentityMigration = true;
  return true;
}

function resolveBotId(store, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return store.pageIdAliases?.[raw.toUpperCase()] || canonicalBotId(raw);
}

function nextPageId(store) {
  const highest = Math.max(0, ...(store.bots || []).map(bot => Number(String(bot.id || '').replace(/^Page/i, '')) || 0));
  if (highest >= 1000) throw new Error('Đã đủ 1000 Page trong A');
  return `Page${highest + 1}`;
}

function ensureBot(store, requestedId) {
  const id = canonicalBotId(requestedId);
  if (!id) return null;
  let bot = store.bots.find(item => item.id === id);
  if (!bot) {
    bot = {
      id,
      status: 'offline',
      lastSeenAt: null,
      page: { name: 'Chưa gán Page', followers: 0, publishedPosts: 0, updatedAt: null },
      sourceUrl: '',
      schedule: { postsPerDay: 1, times: ['09:00'], repeatDaily: true },
      commands: [],
      sourceInventory: []
    };
    store.bots.push(bot);
    addLog(store, id, `${id} đã được thêm vào A`);
  }
  return bot;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
  });
}

function addLog(store, botId, message, level = 'info') {
  store.logs.unshift({ id: randomUUID(), botId, message, level, at: new Date().toISOString() });
  store.logs = store.logs.slice(0, 100);
}

function csvRows(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const parse = line => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') quoted = !quoted;
      else if (character === ',' && !quoted) { values.push(value.trim()); value = ''; }
      else value += character;
    }
    values.push(value.trim());
    return values;
  };
  const headers = parse(lines.shift()).map(header => header.trim());
  return lines.map(line => Object.fromEntries(headers.map((header, index) => [header, parse(line)[index] || ''])));
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function findMedia(folder, row) {
  const named = [row.media_1, row.media_2].filter(Boolean).map(file => path.join(folder, file));
  const listed = named.find(file => fs.existsSync(file));
  if (listed) return listed;
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(item => item.isFile() && MEDIA_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
    .map(item => path.join(folder, item.name))[0];
}

function scanIndexedSource(folder, bot) {
  const indexFile = path.join(folder, 'control', 'post-index.csv');
  return csvRows(fs.readFileSync(indexFile, 'utf8')).map(row => {
    const folderName = row.folder_name || row.post_id;
    const postFolder = path.join(folder, 'posts', folderName);
    const statusFile = path.join(postFolder, 'status.json');
    const stored = readJson(statusFile, {});
    const mediaPath = fs.existsSync(postFolder) ? findMedia(postFolder, row) : undefined;
    const title = row.title || row.post_id;
    const captionPath = path.join(postFolder, row.caption_file || 'caption.txt');
    const caption = fs.existsSync(captionPath) ? fs.readFileSync(captionPath, 'utf8').trim() : title;
    return {
      postId: row.post_id,
      title,
      status: mediaPath ? (stored.status || row.status || 'ready') : 'failed',
      mediaPath,
      caption,
      pageUrl: row.page_url || bot.pageUrl || bot.page?.url || '',
      scheduledAt: row.scheduled_at || '',
      publishedAt: stored.published_at || null,
      updatedAt: stored.last_updated_at || null,
      statusFile,
      captionFromTitleFile: Boolean(row.title || fs.existsSync(captionPath)),
      titleFile: fs.existsSync(captionPath) ? path.basename(captionPath) : 'control/post-index.csv',
      error: mediaPath ? '' : 'Thiếu video/ảnh trong thư mục bài đăng'
    };
  });
}

function mediaFiles(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).sort((first, second) => first.name.localeCompare(second.name, 'vi')).flatMap(item => {
    const target = path.join(folder, item.name);
    if (item.isDirectory()) return mediaFiles(target);
    return item.isFile() && MEDIA_EXTENSIONS.has(path.extname(item.name).toLowerCase()) ? [target] : [];
  });
}

function backupCaption(value) {
  const parts = String(value || '').split(/[|｜]/).map(part => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(1, -1).join(' ') : String(value || '').trim();
}

function scanReelsBackup(folder, bot) {
  const videoFolder = fs.existsSync(path.join(folder, 'video')) ? path.join(folder, 'video') : folder;
  const titleFile = ['titles.txt', 'title.txt', 'captions.txt', 'caption.txt']
    .map(name => path.join(folder, name))
    .find(file => fs.existsSync(file));
  const titleLines = titleFile
    ? fs.readFileSync(titleFile, 'utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    : [];
  const downloaded = fs.existsSync(path.join(folder, 'downloaded.txt'))
    ? fs.readFileSync(path.join(folder, 'downloaded.txt'), 'utf8').split(/\r?\n/).map(value => value.match(/(\d+)\s*$/)?.[1] || '').filter(Boolean)
    : [];
  const titlesById = new Map(downloaded.map((id, index) => [id, titleLines[index] || '']));
  const sequenceById = new Map(downloaded.map((id, index) => [id, index]));
  const statusFile = path.join(folder, '.a-posting-status.json');
  const stored = readJson(statusFile, { jobs: {} });
  const media = mediaFiles(videoFolder);
  const jobs = media.map((mediaPath, index) => {
    const name = path.basename(mediaPath, path.extname(mediaPath));
    const sourceId = name.match(/-\s*(\d+)\s*$/)?.[1] || '';
    const stable = sourceId || createHash('sha1').update(path.relative(folder, mediaPath)).digest('hex').slice(0, 14);
    const postId = `BACKUP-${stable}`;
    const mappedTitle = titlesById.get(sourceId) || '';
    const positionalTitle = !downloaded.length ? (titleLines[index] || '') : '';
    const filenameTitle = name.replace(/-\s*\d+\s*$/, '').trim();
    const captionFromTitleFile = Boolean(mappedTitle || positionalTitle);
    const captionFromFilename = !captionFromTitleFile && Boolean(filenameTitle);
    const captionSource = mappedTitle || positionalTitle || filenameTitle;
    const caption = backupCaption(captionSource) || postId;
    const status = stored.jobs?.[postId] || {};
    return {
      postId,
      title: caption.split(/#/, 1)[0].trim() || caption,
      status: status.status || 'ready',
      mediaPath,
      caption,
      pageUrl: bot.pageUrl || bot.page?.url || '',
      scheduledAt: '',
      publishedAt: status.published_at || null,
      updatedAt: status.last_updated_at || null,
      statusFile,
      statusKind: 'backup-book',
      captionFromTitleFile,
      captionFromFilename,
      captionReady: Boolean(captionSource),
      titleFile: titleFile ? path.basename(titleFile) : '',
      error: status.last_error || ''
    };
  });
  if (!jobs.length) throw new Error('Không tìm thấy video trong thư mục nguồn');
  return jobs.sort((first, second) => {
    const firstId = first.postId.replace('BACKUP-', '');
    const secondId = second.postId.replace('BACKUP-', '');
    return (sequenceById.get(firstId) ?? Number.MAX_SAFE_INTEGER) - (sequenceById.get(secondId) ?? Number.MAX_SAFE_INTEGER)
      || first.mediaPath.localeCompare(second.mediaPath, 'vi');
  });
}

function scanSourceFolder(bot) {
  const folder = String(bot.sourceFolder || '').trim();
  if (!folder) throw new Error('Hãy nhập đường dẫn thư mục nguồn trên máy');
  if (/^https?:\/\//i.test(folder)) throw new Error('A cần đường dẫn thư mục trên máy, không phải link web Drive');
  const indexFile = path.join(folder, 'control', 'post-index.csv');
  return fs.existsSync(indexFile) ? scanIndexedSource(folder, bot) : scanReelsBackup(folder, bot);
}

function hydratePublishedHistory(bot) {
  const current = Array.isArray(bot.sourceInventory) ? bot.sourceInventory : [];
  if (!bot.sourceFolder || !current.some(job => job.status === 'published' && !job.publishedAt && !job.updatedAt)) return false;
  try {
    const fromSource = new Map(scanSourceFolder(bot).map(job => [job.postId, job]));
    let changed = false;
    bot.sourceInventory = current.map(job => {
      if (job.status !== 'published' || job.publishedAt || job.updatedAt) return job;
      const saved = fromSource.get(job.postId);
      if (!saved?.publishedAt && !saved?.updatedAt) return job;
      changed = true;
      return { ...job, publishedAt: saved.publishedAt || null, updatedAt: saved.updatedAt || null };
    });
    const savedPublished = bot.sourceInventory.filter(job => job.status === 'published' && (job.publishedAt || job.updatedAt))
      .map(job => ({ postId: job.postId, at: job.publishedAt || job.updatedAt, title: job.title || job.postId }));
    if (savedPublished.length) {
      const merged = [...savedPublished, ...(bot.recentPublished || [])];
      bot.recentPublished = [...new Map(merged.map(item => [item.postId, item])).values()]
        .sort((first, second) => Date.parse(second.at) - Date.parse(first.at)).slice(0, 30);
      changed = true;
    }
    return changed;
  } catch (_) {
    return false;
  }
}

async function selectSourceFolder() {
  if (!process.versions.electron) throw new Error('Nút chọn thư mục chỉ dùng được khi mở A.exe');
  const { dialog } = require('electron');
  if (!dialog) throw new Error('A chưa sẵn sàng mở hộp chọn thư mục');
  const result = await dialog.showOpenDialog({
    title: 'Chọn thư mục chứa video và titles.txt',
    properties: ['openDirectory']
  });
  return result.canceled ? { canceled: true } : { canceled: false, folder: result.filePaths[0] };
}

function previewSourceFolder(folder) {
  const jobs = scanSourceFolder({ sourceFolder: String(folder || '').trim(), pageUrl: '' });
  const titleCount = jobs.filter(job => job.captionReady ?? job.captionFromTitleFile).length;
  const fileTitleCount = jobs.filter(job => job.captionFromTitleFile).length;
  const filenameTitleCount = jobs.filter(job => job.captionFromFilename).length;
  const titleFile = jobs.find(job => job.titleFile)?.titleFile || 'titles.txt/title.txt';
  const missingTitles = jobs.filter(job => !(job.captionReady ?? job.captionFromTitleFile)).slice(0, 5).map(job => path.basename(job.mediaPath || job.postId));
  return {
    videoCount: jobs.length,
    titleCount,
    fileTitleCount,
    filenameTitleCount,
    titleFile,
    valid: titleCount === jobs.length,
    missingTitles
  };
}

function syncSourceFolder(store, bot, { announce = false } = {}) {
  const jobs = scanSourceFolder(bot);
  const previous = new Map((bot.sourceInventory || []).map(job => [job.postId, job]));
  bot.sourceInventory = jobs.map(job => {
    const old = previous.get(job.postId);
    const keepStatus = old && ['queued', 'in_progress', 'published', 'needs_review'].includes(old.status);
    return { ...job, ...(keepStatus ? { status: old.status, updatedAt: old.updatedAt || null, publishedAt: old.publishedAt || null, error: old.error || job.error } : {}) };
  });
  const signature = JSON.stringify(bot.sourceInventory.map(job => [job.postId, job.status, job.mediaPath, job.caption]));
  const changed = bot.sourceSignature !== signature;
  bot.sourceSignature = signature;
  const counts = jobs.reduce((result, job) => ({ ...result, [job.status]: (result[job.status] || 0) + 1 }), {});
  const titleCount = jobs.filter(job => job.captionReady ?? job.captionFromTitleFile).length;
  const fileTitleCount = jobs.filter(job => job.captionFromTitleFile).length;
  const filenameTitleCount = jobs.filter(job => job.captionFromFilename).length;
  const titleFile = jobs.find(job => job.titleFile)?.titleFile || '';
  const titlesReady = titleCount === jobs.length;
  bot.sourceCheck = {
    status: titlesReady ? 'ready' : 'warning',
    detail: titlesReady
      ? `Đã đọc ${jobs.length} video: ${fileTitleCount} tiêu đề từ ${titleFile || 'file tiêu đề'}${filenameTitleCount ? `, ${filenameTitleCount} tiêu đề từ tên file video` : ''}; ${counts.ready || 0} sẵn sàng, ${counts.published || 0} đã đăng`
      : `Đã đọc ${jobs.length} video nhưng chỉ có ${titleCount}/${jobs.length} tiêu đề trong ${titleFile || 'titles.txt/title.txt'}`,
    checkedAt: new Date().toISOString()
  };
  if (changed || announce) addLog(store, bot.id, `A đã đồng bộ ${jobs.length} video từ thư mục nguồn`, 'success');
  return jobs;
}

function writeOutcomeToSource(job, outcome) {
  if (!job?.statusFile) return;
  if (job.statusKind === 'backup-book') {
    const book = readJson(job.statusFile, { jobs: {} });
    book.jobs ||= {};
    book.jobs[outcome.postId] = {
      status: outcome.status,
      last_updated_at: outcome.at,
      published_at: outcome.status === 'published' ? outcome.at : book.jobs[outcome.postId]?.published_at || null,
      last_error: outcome.error || null,
      media_file: path.basename(job.mediaPath || '')
    };
    fs.writeFileSync(job.statusFile, JSON.stringify(book, null, 2), 'utf8');
    return;
  }
  const previous = readJson(job.statusFile, { post_id: outcome.postId });
  const next = {
    ...previous,
    status: outcome.status,
    last_updated_at: outcome.at,
    published_at: outcome.status === 'published' ? outcome.at : previous.published_at || null,
    last_error: outcome.error || null
  };
  fs.writeFileSync(job.statusFile, JSON.stringify(next, null, 2), 'utf8');
}

function bangkokClock() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function recommendedTimes(postsPerDay) {
  const count = Math.max(1, Math.min(50, Number(postsPerDay) || 1));
  if (count === 1) return ['09:00'];
  const start = 9 * 60;
  const end = 21 * 60;
  return Array.from({ length: count }, (_, index) => {
    const minute = Math.round(start + ((end - start) * index) / (count - 1));
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  });
}

function scheduledTimes(schedule) {
  const limit = Math.max(1, Math.min(50, Number(schedule?.postsPerDay) || 1));
  return [...new Set((schedule?.times || []).map(value => String(value).trim()).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))].slice(0, limit);
}

function previousMinute(time) {
  const [hour, minute] = time.split(':').map(Number);
  const total = ((hour * 60 + minute - 1) + 1_440) % 1_440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function scheduleAllowedOn(bot, date) {
  return bot.schedule?.repeatDaily !== false || !bot.schedule?.scheduledDate || bot.schedule.scheduledDate === date;
}

// A single schedule minute can be shared by many Pages.  AdsPower and
// Facebook are both much more reliable when a batch does not begin the exact
// same action at once.  The hash makes the order change from day to day while
// staying stable if A is restarted during that minute.
function scheduleSlotHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dueScheduleBatch(store, now) {
  return (store.bots || []).flatMap(bot => {
    if (!bot.sourceFolder || !scheduleAllowedOn(bot, now.date)) return [];
    if (!scheduledTimes(bot.schedule).includes(now.time)) return [];
    const key = `${now.date} ${now.time}`;
    if (bot.scheduleRuns?.[key]) return [];
    return [{ bot, key }];
  });
}

function planScheduledBatch(batch, now) {
  const ordered = [...batch].sort((first, second) => {
    const firstHash = scheduleSlotHash(`${now.date}|${now.time}|${first.bot.id}`);
    const secondHash = scheduleSlotHash(`${now.date}|${now.time}|${second.bot.id}`);
    return firstHash - secondHash || first.bot.id.localeCompare(second.bot.id);
  });
  const count = ordered.length;
  // Small groups complete inside roughly 20 seconds.  Bigger groups get a
  // wider lane, up to 48 seconds, so no two Profiles are asked to post at once.
  const windowSeconds = count <= 1 ? 0 : Math.min(48, Math.max(16, count * 3));
  return ordered.map((entry, index) => ({
    ...entry,
    position: index + 1,
    count,
    delaySeconds: count <= 1 ? 1 : 2 + Math.round(index * ((windowSeconds - 2) / (count - 1)))
  }));
}

let scheduleRunning = false;

async function runDailySchedules() {
  if (scheduleRunning) return;
  scheduleRunning = true;
  const store = readStore();
  const now = bangkokClock();
  let changed = false;
  try {
    store.bots.forEach(bot => {
      if (!bot.sourceFolder) return;
      try {
        const signature = bot.sourceSignature;
        syncSourceFolder(store, bot);
        changed ||= signature !== bot.sourceSignature;
      } catch (error) {
        const detail = error.message || 'A không đọc được thư mục Drive';
        if (bot.sourceCheck?.detail !== detail) addLog(store, bot.id, detail, 'error');
        bot.sourceCheck = { status: 'error', detail, checkedAt: new Date().toISOString() };
        changed = true;
      }
    });

    for (const bot of store.bots) {
      const closeAfterAt = new Date(bot.adsPower?.closeAfterAt || 0).getTime();
      if (!bot.adsPower?.profileNumber || !closeAfterAt || closeAfterAt > Date.now()) continue;
      const postStillRunning = (bot.sourceInventory || []).some(job => ['queued', 'in_progress'].includes(job.status));
      if (postStillRunning) {
        bot.adsPower.closeAfterAt = new Date(Date.now() + 60_000).toISOString();
        addLog(store, bot.id, `Page còn đang xử lý bài đăng nên A giữ AdsPower Số Profile ${bot.adsPower.profileNumber} mở thêm 1 phút`, 'info');
        changed = true;
        continue;
      }
      try {
        await closeAdsPowerProfile(store, bot);
        addLog(store, bot.id, `Đã đăng xong: A đã đóng AdsPower Số Profile ${bot.adsPower.profileNumber} để tiết kiệm máy`, 'success');
      } catch (error) {
        bot.adsPower.closeAfterAt = new Date(Date.now() + 60_000).toISOString();
        addLog(store, bot.id, `Chưa đóng được AdsPower Số Profile ${bot.adsPower.profileNumber}: ${error.message}. A sẽ thử lại sau 1 phút`, 'error');
      }
      changed = true;
    }

    for (const bot of store.bots) {
      if (!bot.sourceFolder || !bot.adsPower?.profileNumber) continue;
      const targetTime = scheduledTimes(bot.schedule).find(time => previousMinute(time) === now.time);
      if (!targetTime) continue;
      const targetDate = targetTime === '00:00' && now.time === '23:59' ? nextDate(now.date) : now.date;
      if (!scheduleAllowedOn(bot, targetDate)) continue;
      const key = `${targetDate} ${targetTime}`;
      bot.adsPower.warmups ||= {};
      if (bot.adsPower.warmups[key]) continue;
      bot.adsPower.warmups[key] = { status: 'opening', at: new Date().toISOString() };
      try {
        await openAdsPowerProfile(store, bot);
        bot.adsPower.warmups[key] = { status: 'ready', at: new Date().toISOString() };
        addLog(store, bot.id, `Trước lịch 1 phút: A đã mở AdsPower Số Profile ${bot.adsPower.profileNumber}; chờ ${targetTime} để đăng`, 'success');
      } catch (error) {
        bot.adsPower.warmups[key] = { status: 'failed', at: new Date().toISOString(), error: error.message };
        addLog(store, bot.id, `Không mở được AdsPower Profile trước lịch ${targetTime}: ${error.message}`, 'error');
      }
      changed = true;
    }

    // Put every Page sharing this minute into one staggered posting lane.
    // The Browser Agent only receives a command after notBeforeAt, preventing
    // simultaneous Facebook actions even though all Pages have the same time.
    for (const planned of planScheduledBatch(dueScheduleBatch(store, now), now)) {
      const { bot, key, position, count, delaySeconds } = planned;
      bot.scheduleRuns ||= {};
      Object.keys(bot.scheduleRuns).filter(runKey => runKey < `${now.date.slice(0, 8)}00`).forEach(runKey => delete bot.scheduleRuns[runKey]);
      const notBeforeAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
      bot.scheduleRuns[key] = { queuedAt: new Date().toISOString(), notBeforeAt, position, count };
      if (bot.adsPower?.profileNumber && bot.adsPower.warmups?.[key]?.status !== 'ready') {
        addLog(store, bot.id, `Đến lịch ${now.time}: Profile AdsPower chưa sẵn sàng nên A không gửi lệnh đăng`, 'error');
        changed = true;
        continue;
      }
      const job = bot.sourceInventory?.find(item => item.status === 'ready');
      if (job) {
        job.status = 'queued';
        bot.commands.push({
          id: randomUUID(),
          type: 'post_next',
          job,
          createdAt: new Date().toISOString(),
          scheduled: true,
          notBeforeAt,
          batchPosition: position,
          batchCount: count
        });
        const laneText = count > 1 ? `; lượt ${position}/${count}, chờ ${delaySeconds}s để tránh trùng thao tác` : '';
        addLog(store, bot.id, `Đến lịch ${now.time}: A đã xếp ${job.postId} vào hàng chờ đăng${laneText}`, 'info');
      } else {
        addLog(store, bot.id, `Đến lịch ${now.time}: không có bài ready trong nguồn Drive`, 'error');
      }
      changed = true;
    }
    if (changed) writeStore(store);
  } finally {
    scheduleRunning = false;
  }
}

function applyPageSnapshot(bot, snapshot) {
  if (!snapshot) return;
  bot.page = { ...bot.page, ...snapshot, updatedAt: new Date().toISOString() };
}

function staticFile(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(PUBLIC_DIR, file);
  if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
  return true;
}

function updateFilePaths() {
  const fixed = ['server.js', 'desktop-main.js', 'package.json'];
  const folders = ['public'];
  const collected = [...fixed];
  const collectFolder = (folder, base = ROOT) => {
    const absolute = path.join(base, folder);
    if (!fs.existsSync(absolute)) return;
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.posix.join(folder, item.name);
      if (item.isDirectory()) collectFolder(relative, base);
      else if (item.isFile()) collected.push(relative);
    }
  };
  folders.forEach(folder => collectFolder(folder));
  collectFolder('B-extension', DISTRIBUTION_ROOT);
  return collected.sort();
}

function updateAbsolutePath(relative) {
  return String(relative || '').startsWith('B-extension/')
    ? path.join(DISTRIBUTION_ROOT, relative)
    : path.join(ROOT, relative);
}

const UPDATE_BOOTSTRAP_PATHS = new Set([
  'public/assets/eu-media-logo.png',
  'public/assets/eu-media-logo.ico'
]);

function validUpdatePath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  return updateFilePaths().includes(normalized) || UPDATE_BOOTSTRAP_PATHS.has(normalized) ? normalized : '';
}

function updateManifest() {
  return {
    version: RELEASE_VERSION,
    generatedAt: new Date().toISOString(),
    files: updateFilePaths().map(relative => {
      const content = fs.readFileSync(updateAbsolutePath(relative));
      return { path: relative, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    })
  };
}

function hubRequestAllowed(store, req) {
  const network = store.network || {};
  return network.mode === 'hub' && networkKeyMatches(network.sharedKey, networkAuthorization(req));
}

function atomicWriteFile(file, content) {
  const folder = path.dirname(file);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const temporary = path.join(folder, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

async function applyUpdateFromHub(store) {
  const network = store.network || {};
  if (network.mode !== 'worker') throw new Error('Chỉ máy Worker mới nhận cập nhật từ Hub');
  if (!network.hubUrl || !network.sharedKey) throw new Error('Hãy nhập địa chỉ Hub và mã ghép nối trước');
  const baseUrl = networkBaseUrl(network.hubUrl);
  const headers = { Authorization: `Bearer ${network.sharedKey}` };
  const manifest = await jsonRequest(`${baseUrl}/api/network/update/manifest`, { method: 'GET', headers, timeout: 15_000 });
  if (!Array.isArray(manifest.files)) throw new Error('Hub không trả về gói cập nhật hợp lệ');
  const local = new Map(updateManifest().files.map(item => [item.path, item.sha256]));
  const changed = manifest.files.filter(item => validUpdatePath(item.path) && local.get(item.path) !== item.sha256);
  for (const item of changed) {
    const encoded = await jsonRequest(`${baseUrl}/api/network/update/file?path=${encodeURIComponent(item.path)}`, { method: 'GET', headers, timeout: 30_000 });
    const content = Buffer.from(String(encoded.content || ''), 'base64');
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== item.sha256) throw new Error(`Tệp cập nhật ${item.path} không đúng mã kiểm tra`);
    atomicWriteFile(updateAbsolutePath(item.path), content);
  }
  return { version: manifest.version, changed: changed.map(item => item.path), restartRequired: changed.length > 0 };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, publicStore(readStore()));
    if (req.method === 'PUT' && url.pathname === '/api/update/github-config') {
      const store = readStore();
      const payload = await body(req);
      store.updates = { ...store.updates, ...normalizeGitHubSettings(payload) };
      writeStore(store);
      return json(res, 200, { ok: true, updates: updatesPublic(store.updates) });
    }
    if (req.method === 'POST' && url.pathname === '/api/update/github-check') {
      const store = readStore();
      try {
        const result = await checkGitHubUpdate(store);
        return json(res, 200, { ok: true, ...result, updates: updatesPublic(store.updates) });
      } catch (error) {
        store.updates.lastCheckedAt = new Date().toISOString();
        store.updates.lastError = error.message || 'Không kiểm tra được GitHub';
        writeStore(store);
        throw error;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/update/github-apply') {
      const store = readStore();
      try {
        const result = await applyUpdateFromGitHub(store);
        return json(res, 200, { ok: true, ...result, updates: updatesPublic(store.updates) });
      } catch (error) {
        store.updates.lastCheckedAt = new Date().toISOString();
        store.updates.lastError = error.message || 'Không cập nhật được từ GitHub';
        writeStore(store);
        throw error;
      }
    }
    if (req.method === 'PUT' && url.pathname === '/api/network/config') {
      const store = readStore();
      const payload = await body(req);
      const mode = NETWORK_MODES.has(payload.mode) ? payload.mode : 'standalone';
      const proposedHub = String(payload.hubUrl || '').trim();
      const providedKey = String(payload.sharedKey || '').trim();
      store.network = {
        ...store.network,
        mode,
        machineName: String(payload.machineName || store.network.machineName || os.hostname()).trim().slice(0, 80) || os.hostname(),
        hubUrl: mode === 'worker' && proposedHub ? networkBaseUrl(proposedHub) : (mode === 'worker' ? String(store.network.hubUrl || '') : ''),
        sharedKey: providedKey || (mode === 'hub' ? (store.network.sharedKey || randomBytes(18).toString('base64url')) : String(store.network.sharedKey || '')),
        machineId: String(store.network.machineId || `machine-${randomBytes(5).toString('hex')}`)
      };
      if (mode !== 'worker') store.network.lastReportError = '';
      writeStore(store);
      const report = mode === 'worker' ? await sendHubReport() : { skipped: true };
      return json(res, 200, {
        ok: true,
        network: networkPublic(store.network),
        ...(mode === 'hub' ? { pairingKey: store.network.sharedKey } : {}),
        report
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/network/new-key') {
      const store = readStore();
      if (store.network.mode !== 'hub') return json(res, 400, { error: 'Hãy chọn chế độ A Trung tâm trước khi tạo mã ghép nối' });
      store.network.sharedKey = randomBytes(18).toString('base64url');
      writeStore(store);
      return json(res, 200, { ok: true, sharedKey: store.network.sharedKey, network: networkPublic(store.network) });
    }
    if (req.method === 'POST' && url.pathname === '/api/network/test') {
      const store = readStore();
      if (store.network.mode === 'worker') {
        const report = await sendHubReport();
        if (report?.ok === false) return json(res, 502, { error: report.error || 'Không gửi được báo cáo đến Hub' });
        return json(res, 200, { ok: true, message: 'Worker đã gửi báo cáo đến Hub' });
      }
      if (store.network.mode === 'hub') return json(res, 200, { ok: true, message: `Hub đang nhận ${Object.keys(store.hubMachines || {}).length} máy Worker` });
      return json(res, 400, { error: 'Hãy chọn A Trung tâm hoặc Máy Worker trước' });
    }
    if (req.method === 'POST' && url.pathname === '/api/network/report') {
      const store = readStore();
      if (!hubRequestAllowed(store, req)) return json(res, 401, { error: 'Mã ghép nối không đúng hoặc máy này chưa là Hub' });
      const report = await body(req);
      const machineId = String(report.machineId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      if (!machineId) return json(res, 400, { error: 'Worker không có mã máy hợp lệ' });
      const previous = store.hubMachines[machineId] || {};
      const errors = Array.isArray(report.errors) ? report.errors.slice(0, 12) : [];
      store.hubMachines[machineId] = {
        machineId,
        machineName: String(report.machineName || machineId).slice(0, 80),
        version: String(report.version || ''),
        lastSeenAt: String(report.sentAt || new Date().toISOString()),
        receivedAt: new Date().toISOString(),
        pages: Array.isArray(report.pages) ? report.pages.slice(0, 1000) : [],
        errors
      };
      writeStore(store);
      const newestError = errors[0];
      if (newestError?.at && newestError.at !== previous.errors?.[0]?.at) {
        sendTelegram(store, `<b>⚠ Lỗi từ ${escapeTelegramHtml(store.hubMachines[machineId].machineName)}</b>\n${escapeTelegramHtml(newestError.botId || '')}: ${escapeTelegramHtml(newestError.message || 'Không rõ lỗi')}`).catch(() => {});
      }
      return json(res, 200, { ok: true, hubVersion: RELEASE_VERSION });
    }
    if (req.method === 'GET' && url.pathname === '/api/network/update/manifest') {
      const store = readStore();
      if (!hubRequestAllowed(store, req)) return json(res, 401, { error: 'Không có quyền lấy bản cập nhật' });
      return json(res, 200, updateManifest());
    }
    if (req.method === 'GET' && url.pathname === '/api/network/update/file') {
      const store = readStore();
      if (!hubRequestAllowed(store, req)) return json(res, 401, { error: 'Không có quyền lấy tệp cập nhật' });
      const relative = validUpdatePath(url.searchParams.get('path'));
      if (!relative) return json(res, 404, { error: 'Tệp cập nhật không hợp lệ' });
      const content = fs.readFileSync(updateAbsolutePath(relative));
      return json(res, 200, { path: relative, content: content.toString('base64') });
    }
    if (req.method === 'POST' && url.pathname === '/api/network/update/apply') {
      const store = readStore();
      const result = await applyUpdateFromHub(store);
      return json(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-source-folder') {
      return json(res, 200, await selectSourceFolder());
    }
    if (req.method === 'POST' && url.pathname === '/api/source-preview') {
      const payload = await body(req);
      return json(res, 200, previewSourceFolder(payload.sourceFolder));
    }
    if (req.method === 'PUT' && url.pathname === '/api/notifications/config') {
      const store = readStore();
      const payload = await body(req);
      const telegramToken = String(payload.telegramToken || '').trim();
      const telegramChatId = String(payload.telegramChatId || '').trim();
      const aiApiKey = String(payload.aiApiKey || '').trim();
      const telegram = {
        ...store.notifications.telegram,
        ...(telegramToken ? { botToken: telegramToken } : {}),
        ...(telegramChatId ? { chatId: telegramChatId } : {}),
        enabled: Boolean(payload.telegramEnabled)
      };
      const ai = {
        ...store.notifications.ai,
        ...(aiApiKey ? { apiKey: aiApiKey } : {}),
        model: String(payload.aiModel || store.notifications.ai.model || 'gpt-5.6-terra').trim(),
        enabled: Boolean(payload.aiEnabled)
      };
      if (telegram.enabled && (!telegram.botToken || !telegram.chatId)) return json(res, 400, { error: 'Hãy nhập Telegram Bot Token và Chat ID trước khi bật gửi tự động' });
      if (ai.enabled && !ai.apiKey) return json(res, 400, { error: 'Hãy nhập OpenAI API key trước khi bật AI Agent' });
      store.notifications = { telegram, ai };
      writeStore(store);
      return json(res, 200, { ok: true, notifications: notificationsPublic(store.notifications) });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/find-chat') {
      const payload = await body(req);
      return json(res, 200, await findTelegramChat(String(payload.telegramToken || '').trim()));
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/test') {
      const store = readStore();
      await sendTelegram(store, '<b>✅ A đã kết nối Telegram</b>\nTừ bây giờ A có thể gửi báo cáo Page, bài thành công và lỗi.', { force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/daily-summary') {
      const store = readStore();
      await notifyDailySummary(store, { force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && url.pathname === '/api/adspower/config') {
      const store = readStore();
      const payload = await body(req);
      const apiKey = String(payload.apiKey || '').trim();
      store.adsPower = {
        ...store.adsPower,
        baseUrl: adsPowerBaseUrl(payload.baseUrl || store.adsPower.baseUrl),
        windowLayout: normalizeAdsPowerWindowLayout(payload.windowLayout || store.adsPower.windowLayout),
        ...(apiKey ? { apiKey } : {})
      };
      const profiles = await listAdsPowerProfiles(store.adsPower);
      writeStore(store);
      return json(res, 200, { ok: true, adsPower: adsPowerPublic(store.adsPower), profileCount: profiles.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/adspower/profiles') {
      const store = readStore();
      const profiles = await listAdsPowerProfiles(store.adsPower);
      return json(res, 200, { profiles, adsPower: adsPowerPublic(store.adsPower) });
    }
    if (req.method === 'POST' && url.pathname === '/api/pages/connect') {
      const payload = await body(req);
      const connected = await queueAdsPowerPairing(async () => {
        const store = readStore();
        const pageId = resolveBotId(store, payload.pageId) || resolveBotId(store, payload.legacyId) || nextPageId(store);
        store.deletedBots = (store.deletedBots || []).filter(id => id !== pageId);
        const bot = ensureBot(store, pageId);
        let adsPowerAutoBind = { status: 'already_bound', profileNumber: bot.adsPower?.profileNumber || '' };
        if (!String(bot.adsPower?.profileNumber || '').trim()) {
          try {
            adsPowerAutoBind = await autoBindActiveAdsPowerProfile(store, bot, payload.browser);
            if (adsPowerAutoBind.status === 'not_found') addLog(store, bot.id, 'Chưa tự gán được AdsPower: không thấy Profile có dấu nhận diện trình duyệt phù hợp', 'info');
            if (adsPowerAutoBind.status === 'ambiguous') addLog(store, bot.id, `Chưa tự gán AdsPower: có ${adsPowerAutoBind.matchedUserAgents || adsPowerAutoBind.activeCount || 0} Profile trùng dấu nhận diện`, 'info');
          } catch (error) {
            adsPowerAutoBind = { status: 'error' };
            addLog(store, bot.id, `Chưa tự gán được AdsPower: ${error.message}`, 'info');
          }
        }
        writeStore(store);
        return { ok: true, pageId: bot.id, bot, adsPowerAutoBind };
      });
      return json(res, 200, connected);
    }
    if (req.method === 'POST' && url.pathname === '/api/bots') {
      const store = readStore();
      const payload = await body(req);
      const botId = resolveBotId(store, payload.id);
      if (!botId) return json(res, 400, { error: 'Mã Page phải từ Page1 đến Page1000' });
      store.deletedBots = (store.deletedBots || []).filter(id => id !== botId);
      const bot = ensureBot(store, botId);
      writeStore(store);
      return json(res, 201, { bot });
    }
    if (parts[0] === 'api' && parts[1] === 'bots' && parts[2]) {
      const store = readStore();
      const botId = resolveBotId(store, decodeURIComponent(parts[2]));
      if (!botId) return json(res, 400, { error: 'Mã Page phải từ Page1 đến Page1000' });
      if ((store.deletedBots || []).includes(botId)) return json(res, 410, { error: `${botId} đã bị xóa khỏi A. Bấm Kết nối trong extension để thêm lại.` });
      const bot = ensureBot(store, botId);
      if (req.method === 'GET' && !parts[3] && bot) {
        // Persist an ID opened directly from the extension as well. This makes
        // Page IDs appear in A without having to pre-create rows.
        writeStore(store);
        return json(res, 200, { bot });
      }
      if (!bot) return json(res, 404, { error: 'Không tìm thấy Page' });

      if (req.method === 'DELETE' && !parts[3]) {
        store.bots = store.bots.filter(item => item.id !== botId);
        store.logs = (store.logs || []).filter(item => item.botId !== botId);
        store.deletedBots = [...new Set([...(store.deletedBots || []), botId])];
        writeStore(store);
        return json(res, 200, { ok: true, id: botId });
      }

      if (req.method === 'POST' && parts[3] === 'heartbeat') {
        const payload = await body(req);
        bot.status = 'online';
        bot.lastSeenAt = new Date().toISOString();
        applyPageSnapshot(bot, payload.page);
        writeStore(store);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'events') {
        const payload = await body(req);
        addLog(store, botId, payload.message || 'Page gửi trạng thái', payload.level || 'info');
        if (payload.page) applyPageSnapshot(bot, payload.page);
        if (payload.sourceCheck) bot.sourceCheck = payload.sourceCheck;
        if (payload.postOutcome?.postId) {
          bot.postOutcomes = { ...(bot.postOutcomes || {}), [payload.postOutcome.postId]: payload.postOutcome };
          const job = bot.sourceInventory?.find(item => item.postId === payload.postOutcome.postId);
          if (job) {
            Object.assign(job, { status: payload.postOutcome.status, updatedAt: payload.postOutcome.at, ...(payload.postOutcome.status === 'published' ? { publishedAt: payload.postOutcome.at } : {}) });
            writeOutcomeToSource(job, payload.postOutcome);
          }
          if (payload.postOutcome.status === 'published') {
            const existing = (bot.recentPublished || []).filter(item => item.postId !== payload.postOutcome.postId);
            bot.recentPublished = [{
              postId: payload.postOutcome.postId,
              at: payload.postOutcome.at || new Date().toISOString(),
              title: job?.title || payload.postOutcome.title || payload.postOutcome.postId
            }, ...existing].slice(0, 30);
          }
          if (payload.postOutcome.status === 'published' && !bot.confirmedPosts?.[payload.postOutcome.postId]) {
            bot.confirmedPosts = { ...(bot.confirmedPosts || {}), [payload.postOutcome.postId]: payload.postOutcome.at };
            bot.page = {
              ...(bot.page || {}),
              publishedPosts: Math.max(0, Number(bot.page?.publishedPosts) || 0) + 1,
              updatedAt: new Date().toISOString()
            };
            addLog(store, botId, `A đã cập nhật số Reel Page xác nhận đăng: ${bot.page.publishedPosts}`, 'success');
          }
          if (bot.adsPower?.profileNumber && ['published', 'failed', 'needs_review'].includes(payload.postOutcome.status)) {
            bot.adsPower.closeAfterAt = new Date(Date.now() + 60_000).toISOString();
            addLog(store, botId, `Page đã hoàn tất ${payload.postOutcome.postId}: A sẽ đóng AdsPower Số Profile ${bot.adsPower.profileNumber} sau khoảng 1 phút`, 'info');
          }
          const terminalOutcome = ['published', 'failed', 'needs_review'].includes(payload.postOutcome.status);
          const notificationKey = `${payload.postOutcome.postId}:${payload.postOutcome.status}`;
          if (terminalOutcome && store.notifications?.telegram?.enabled && !bot.notifiedOutcomes?.[notificationKey]) {
            bot.notifiedOutcomes = { ...(bot.notifiedOutcomes || {}), [notificationKey]: new Date().toISOString() };
            try {
              await notifyPostOutcome(store, bot, payload.postOutcome);
              addLog(store, botId, `Đã gửi báo cáo ${payload.postOutcome.status === 'published' ? 'thành công' : 'lỗi'} sang Telegram`, 'success');
            } catch (error) {
              addLog(store, botId, `Không gửi được Telegram: ${error.message}`, 'error');
            }
          }
        }
        writeStore(store);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'direct-upload') {
        const payload = await body(req);
        const result = await uploadFileViaAdsPower(bot, {
          filePath: String(payload.filePath || ''),
          pageUrl: String(payload.pageUrl || bot.pageUrl || '')
        });
        bot.lastSeenAt = new Date().toISOString();
        addLog(store, botId, 'A đã gắn file video qua kênh trực tiếp AdsPower', 'success');
        writeStore(store);
        return json(res, 200, result);
      }
      if (req.method === 'POST' && parts[3] === 'source-sync') {
        const payload = await body(req);
        // A post result is returned to the desktop agent once, so it can
        // write status.json. Keeping it forever used to overwrite a manually
        // reset "ready" job with an old failed result on every sync.
        const outcomes = bot.postOutcomes || {};
        bot.postOutcomes = {};
        const previous = new Map((bot.sourceInventory || []).map(job => [job.postId, job]));
        bot.sourceInventory = (payload.jobs || []).map(job => {
          const old = previous.get(job.postId);
          const keepStatus = old && ['queued', 'in_progress', 'published', 'needs_review'].includes(old.status);
          return { ...job, ...(keepStatus ? { status: old.status, updatedAt: old.updatedAt || null, publishedAt: old.publishedAt || null, error: old.error || job.error } : {}) };
        });
        bot.agentLastSeenAt = new Date().toISOString();
        const signature = JSON.stringify(bot.sourceInventory.map(job => [job.postId, job.status, job.mediaPath]));
        if (bot.sourceSignature !== signature) addLog(store, botId, `Page Agent đã đồng bộ ${bot.sourceInventory.length} bài từ nguồn`);
        bot.sourceSignature = signature;
        writeStore(store);
        return json(res, 200, { ok: true, outcomes });
      }
      if (req.method === 'GET' && parts[3] === 'commands') {
        const commands = bot.commands.filter(command => {
          if (command.deliveredAt) return false;
          const notBefore = Date.parse(command.notBeforeAt || '');
          return !Number.isFinite(notBefore) || notBefore <= Date.now();
        });
        commands.forEach(command => command.deliveredAt = new Date().toISOString());
        writeStore(store);
        return json(res, 200, { commands });
      }
      if (req.method === 'POST' && parts[3] === 'commands') {
        const payload = await body(req);
        if (payload.type === 'check_source') {
          const jobs = syncSourceFolder(store, bot, { announce: true });
          writeStore(store);
          return json(res, 200, { ok: true, jobs });
        }
        const job = payload.type === 'post_next'
          ? bot.sourceInventory?.find(item => item.status === 'ready')
          : payload.job;
        if (payload.type === 'post_next' && !job) return json(res, 409, { error: 'Không có bài sẵn sàng trong nguồn của Page này' });
        let adspowerOpened = false;
        if (payload.type === 'post_next' && bot.adsPower?.profileNumber) {
          try {
            const openedAt = Date.parse(bot.adsPower.lastOpenedAt || '');
            const recentlyOpened = Number.isFinite(openedAt) && Date.now() - openedAt < 120_000;
            if (!recentlyOpened) {
              await openAdsPowerProfile(store, bot);
              adspowerOpened = true;
              addLog(store, botId, `Đăng ngay: A đã mở AdsPower Số Profile ${bot.adsPower.profileNumber}; chờ extension Page kết nối để đăng`, 'success');
            } else {
              addLog(store, botId, `Đăng ngay: AdsPower Số Profile ${bot.adsPower.profileNumber} vừa được mở, A dùng lại Profile đang sẵn sàng`, 'info');
            }
          } catch (error) {
            addLog(store, botId, `Không mở được AdsPower Số Profile ${bot.adsPower.profileNumber}: ${error.message}`, 'error');
            writeStore(store);
            return json(res, 502, { error: `Chưa mở được AdsPower Profile: ${error.message}` });
          }
        }
        if (job && payload.type === 'post_next') job.status = 'queued';
        const command = { id: randomUUID(), type: payload.type, job, createdAt: new Date().toISOString() };
        bot.commands.push(command);
        addLog(store, botId, `A gửi lệnh: ${payload.type}`);
        writeStore(store);
        return json(res, 200, { command, adspowerOpened, profileNumber: bot.adsPower?.profileNumber || '' });
      }
      if (req.method === 'POST' && parts[3] === 'adspower') {
        const payload = await body(req);
        const profileNumber = String(payload.profileNumber || '').trim();
        if (!/^\d+$/.test(profileNumber)) return json(res, 400, { error: 'Số Profile AdsPower chỉ được gồm chữ số' });
        bot.adsPower = {
          profileNumber,
          profileName: `Số Profile ${profileNumber}`,
          boundAt: new Date().toISOString(),
          launchStatus: 'idle'
        };
        addLog(store, botId, `Đã gán AdsPower Số Profile ${profileNumber} cho ${botId}`, 'success');
        writeStore(store);
        return json(res, 200, { bot });
      }
      if (req.method === 'POST' && parts[3] === 'adspower-start') {
        const result = await openAdsPowerProfile(store, bot);
        addLog(store, botId, result.skipped ? 'Page này chưa được gán Số Profile AdsPower' : `A đang mở AdsPower Số Profile ${bot.adsPower.profileNumber}`, result.skipped ? 'error' : 'success');
        writeStore(store);
        return json(res, 200, { ok: !result.skipped, adsPower: bot.adsPower });
      }
      if (req.method === 'PUT' && parts[3] === 'config') {
        const payload = await body(req);
        bot.sourceFolder = payload.sourceFolder ?? bot.sourceFolder;
        bot.pageUrl = payload.pageUrl ?? bot.pageUrl;
        const proposed = { ...bot.schedule, ...(payload.schedule || {}) };
        const suppliedTimes = [...new Set((proposed.times || []).map(value => String(value).trim()).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))];
        // Each selected hour represents one post. Never replace the user's
        // selected times with suggested defaults merely because the old count
        // was higher than the number of selected times.
        const postsPerDay = suppliedTimes.length
          ? suppliedTimes.length
          : Math.max(1, Math.min(50, Number(proposed.postsPerDay) || 1));
        const repeatDaily = payload.schedule?.repeatDaily !== false;
        bot.schedule = {
          ...proposed,
          postsPerDay,
          times: suppliedTimes.length ? suppliedTimes : recommendedTimes(postsPerDay),
          repeatDaily,
          scheduledDate: repeatDaily ? null : bangkokClock().date
        };
        if (bot.sourceFolder) syncSourceFolder(store, bot, { announce: true });
        addLog(store, botId, 'Đã cập nhật nguồn và lịch đăng');
        writeStore(store);
        return json(res, 200, { bot });
      }
    }
    if (!staticFile(res, url.pathname)) json(res, 404, { error: 'Không tìm thấy' });
  } catch (error) {
    json(res, 400, { error: error.message || 'Lỗi dữ liệu' });
  }
});

async function restoreBrandAssets() {
  const config = { githubRepo: GITHUB_UPDATE_REPOSITORY, githubBranch: 'main' };
  const assets = [
    ['public/assets/eu-media-logo.png', 'public__assets__eu-media-logo.png'],
    ['public/assets/eu-media-logo.ico', 'public__assets__eu-media-logo.ico']
  ];
  for (const [localPath, remotePath] of assets) {
    const target = updateAbsolutePath(localPath);
    if (fs.existsSync(target)) continue;
    try {
      const content = await githubRepositoryFile(config, remotePath);
      atomicWriteFile(target, content);
    } catch (_) {
      // The page header also has a remote-image fallback; do not block Tool startup.
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`A đang chạy tại http://localhost:${PORT}`));
const startupAssetsReady = restoreBrandAssets();
setTimeout(() => { runDailySchedules().catch(() => {}); }, 2_000);
setInterval(() => { runDailySchedules().catch(() => {}); }, 15_000);

// The regular 15-second check is useful for retries and source refreshes.
// This extra pulse lands just after every minute boundary so a staggered batch
// starts from its intended time rather than from an arbitrary polling second.
function armMinuteBoundarySchedule() {
  const delay = Math.max(250, 60_000 - (Date.now() % 60_000) + 120);
  setTimeout(() => {
    runDailySchedules().catch(() => {});
    armMinuteBoundarySchedule();
  }, delay);
}
armMinuteBoundarySchedule();
// Worker heartbeat keeps the Hub dashboard accurate even when no Page is
// posting or changing state.
setInterval(() => { sendHubReport().catch(() => {}); }, 30_000);

module.exports = { startupAssetsReady };
