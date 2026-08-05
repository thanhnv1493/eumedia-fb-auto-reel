const DEFAULTS = { serverUrl: 'http://localhost:3000', pageId: '' };
let lastSnapshotAt = 0;

async function config() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function event(message, level = 'info', extra = {}) {
  const { serverUrl, pageId } = await config();
  if (!pageId) throw new Error('Chưa kết nối Page với A');
  return fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, level, ...extra })
  });
}

async function botInfo() {
  const { serverUrl, pageId } = await config();
  if (!pageId) throw new Error('Chưa kết nối Page với A');
  const response = await fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}`);
  if (!response.ok) throw new Error('Không lấy được cấu hình Page');
  return (await response.json()).bot;
}

async function attachMediaFileViaA(tabId, filePath) {
  const { serverUrl, pageId } = await config();
  if (!pageId) throw new Error('Chưa kết nối Page với A');
  const tab = await chrome.tabs.get(tabId);
  const response = await fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}/direct-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, pageUrl: tab.url || '' })
  });
  let detail = {};
  try { detail = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(detail.error || 'A không gắn được file qua kênh AdsPower');
  return detail;
}

async function facebookTab() {
  const tabs = await chrome.tabs.query({ url: ['https://facebook.com/*', 'https://www.facebook.com/*'] });
  return tabs.find(tab => tab.url?.startsWith('https://facebook.com/') || tab.url?.startsWith('https://www.facebook.com/'));
}

async function reportPage(tab) {
  try {
    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const fullText = document.body?.innerText || '';
        const lines = fullText.split(/\n+/).map(value => value.trim()).filter(Boolean);
        const followerIndex = lines.findIndex(value => /([0-9.,]+\s*[KM]?)\s*(người theo dõi|followers)/i.test(value));
        const followerMatch = followerIndex >= 0
          ? lines[followerIndex].match(/([0-9.,]+\s*[KM]?)\s*(người theo dõi|followers)/i)
          : null;
        const readCount = value => {
          if (!value) return undefined;
          const compact = value.replace(/\s/g, '').replace(',', '.');
          const multiplier = /k$/i.test(compact) ? 1_000 : /m$/i.test(compact) ? 1_000_000 : 1;
          const raw = compact.replace(/[KM]/ig, '').replace(/\.(?=\d{3}(?:\D|$))/g, '');
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : undefined;
        };
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content
          ?.replace(/\s*\|\s*Facebook$/i, '').trim();
        const generic = value => !value || /^(facebook|quản lý trang|manage page|chia sẻ suy nghĩ|bạn đang nghĩ gì|what.?s on your mind|tất cả|all|giới thiệu|about|bài viết|posts|reels|ảnh|photos|người theo dõi|followers)$/i.test(value);
        const managerIndex = lines.findIndex(value => /^(quản lý trang|manage page)$/i.test(value));
        const managerPageName = managerIndex >= 0
          ? lines.slice(managerIndex + 1, managerIndex + 6).find(value => !generic(value) && !/^(công cụ|thông tin|kiếm tiền|trung tâm|tạo quảng cáo|quảng bá|cài đặt|meta|chú ý)/i.test(value))
          : undefined;
        const currentPath = location.pathname.replace(/\/+$/, '').toLowerCase();
        const linkedPageNames = [...document.querySelectorAll('a[href]')].map(anchor => {
          let anchorPath = '';
          try { anchorPath = new URL(anchor.href, location.href).pathname.replace(/\/+$/, '').toLowerCase(); } catch (_) { return ''; }
          if (!currentPath || anchorPath !== currentPath) return '';
          return `${anchor.innerText || anchor.getAttribute('aria-label') || ''}`.split(/\n+/)[0].trim();
        }).filter(value => value && value.length <= 80 && !generic(value));
        const linkedPageName = linkedPageNames.sort((first, second) => first.length - second.length)[0];
        const fallbackName = followerIndex >= 2 ? lines[followerIndex - 2] : undefined;
        const name = !generic(managerPageName) ? managerPageName : (!generic(linkedPageName) ? linkedPageName : (!generic(ogTitle) ? ogTitle : (!generic(fallbackName) ? fallbackName : undefined)));
        const followers = readCount(followerMatch?.[1]);
        return { ...(name ? { name } : {}), ...(followers !== undefined ? { followers } : {}), url: location.href };
      }
    });
    if (!page || (!page.name && page.followers === undefined)) throw new Error('Không tìm thấy dữ liệu Page');
    return { ok: true, page };
  } catch (_) {
    return { ok: false };
  }
}

async function checkSource() {
  try {
    const bot = await botInfo();
    if (bot.sourceFolder) {
      return event('Nguồn Drive được A quét trực tiếp từ thư mục đã cấu hình', 'success');
    }
    const response = await fetch(bot.sourceUrl, { credentials: 'include', redirect: 'follow' });
    const sourceCheck = {
      status: response.ok ? 'ready' : 'error',
      detail: response.ok ? 'Page truy cập được link nguồn' : `Link nguồn trả về lỗi ${response.status}`,
      checkedAt: new Date().toISOString()
    };
    return event(sourceCheck.detail, response.ok ? 'success' : 'error', { sourceCheck });
  } catch (_) {
    return event('Page không truy cập được link nguồn. Kiểm tra link hoặc quyền Drive.', 'error', {
      sourceCheck: { status: 'error', detail: 'Page không truy cập được link nguồn', checkedAt: new Date().toISOString() }
    });
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const variedDelay = (minimum, maximum) => delay(minimum + Math.floor(Math.random() * (maximum - minimum + 1)));

function descriptionFor(job) {
  const title = String(job?.title || '').trim();
  const caption = String(job?.caption || '').trim();
  if (!title || !caption) return caption || title;
  return caption.toLocaleLowerCase('vi-VN').includes(title.toLocaleLowerCase('vi-VN')) ? caption : `${title}\n${caption}`;
}

async function fillCaption(tabId, caption, { reelOnly = false } = {}) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [caption, reelOnly],
      func: (text, requireReelDescription) => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        // Reel uses a textarea ("Mô tả thước phim của bạn…"), while a normal
        // Page post uses a contenteditable element. Support both deliberately.
        const textareas = [...document.querySelectorAll('textarea')].filter(visible);
        const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].filter(visible);
        const candidates = [...textareas, ...editors];
        const isReelDescription = element => /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('aria-placeholder') || ''} ${element.innerText || ''} ${element.outerHTML || ''}`);
        const isInsideReelSettings = element => /cài đặt thước phim|reel settings/i.test(element.closest('[role="dialog"]')?.innerText || '');
        const reelDescription = candidates.find(isReelDescription)
          || (requireReelDescription ? candidates.find(isInsideReelSettings) : null);
        if (requireReelDescription && !reelDescription) return { waiting: true };
        const editor = reelDescription || textareas[0] || editors.find(element => /bạn đang nghĩ gì|what.?s on your mind|viết gì đó/i.test(`${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`)) || editors[0];
        if (!editor) return { waiting: true };
        const current = editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
        if (current.includes(text.trim())) return { ok: true, alreadyFilled: true, target: editor instanceof HTMLTextAreaElement ? 'reel-description' : 'post-caption' };
        // Mark and focus only. Text is entered character-by-character below
        // through Chrome's input channel rather than assigning/pasting a value.
        document.querySelectorAll('[data-b-caption-target="true"]').forEach(element => element.removeAttribute('data-b-caption-target'));
        editor.focus();
        editor.setAttribute('data-b-caption-target', 'true');
        return { ok: true, target: editor instanceof HTMLTextAreaElement ? 'reel-description' : 'post-caption', type: editor instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable' };
      }
    });
    if (result?.ok) {
      if (result.alreadyFilled) return result;
      if (reelOnly) {
        await typeReelDescriptionWithKeyboard(tabId, caption);
        return result;
      }
      await chrome.debugger.attach({ tabId }, '1.3');
      try {
        for (const character of String(caption).replace(/\r\n/g, '\n')) {
          if (character === '\n') {
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          } else {
            await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: character });
          }
          await variedDelay(45, 95);
        }
      } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
      // Some Facebook builds swallow DevTools text input while replacing the
      // textarea. Fall back to one controlled input event per character; this
      // is still typing, never a single paste/whole-value insertion.
      const received = await confirmDescription(tabId, caption);
      if (!received.ok) await typeCaptionCharacterByCharacter(tabId, caption);
      return result;
    }
    await delay(1_000);
  }
  throw new Error('Không tìm thấy ô nhập caption trong màn hình tạo bài viết');
}

async function typeCaptionCharacterByCharacter(tabId, caption, { reelOnly = false } = {}) {
  const [{ result: prepared }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [reelOnly],
    func: requireReelDescription => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
      const reelDescription = fields.find(element => /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`))
        || (requireReelDescription && /cài đặt thước phim|reel settings/i.test(document.body?.innerText || '') ? fields[0] : null);
      const editor = reelDescription || (!requireReelDescription ? document.querySelector('[data-b-caption-target="true"]') : null);
      if (!editor) return;
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter ? setter.call(editor, '') : (editor.value = '');
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      } else {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
      return true;
    }
  });
  if (!prepared) throw new Error('Không còn tìm thấy ô Mô tả thước phim để nhập nội dung');
  for (const character of String(caption).replace(/\r\n/g, '\n')) {
    const [{ result: typed }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [character, reelOnly],
      func: (value, requireReelDescription) => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
        const reelDescription = fields.find(element => /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`))
          || (requireReelDescription && /cài đặt thước phim|reel settings/i.test(document.body?.innerText || '') ? fields[0] : null);
        const editor = reelDescription || (!requireReelDescription ? document.querySelector('[data-b-caption-target="true"]') : null);
        if (!editor) return;
        editor.focus();
        if (editor instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter ? setter.call(editor, `${editor.value}${value}`) : (editor.value += value);
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: value === '\n' ? 'insertLineBreak' : 'insertText', data: value }));
        } else {
          document.execCommand('insertText', false, value);
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        }
        return true;
      }
    });
    if (!typed) throw new Error('Ô Mô tả thước phim đã biến mất trong lúc nhập nội dung');
    await variedDelay(45, 95);
  }
}

async function typeReelDescriptionWithKeyboard(tabId, caption) {
  const pickAndFocus = async clear => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [clear],
      func: shouldClear => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
        const hasDescriptionHint = element => /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('aria-placeholder') || ''} ${element.innerText || ''} ${element.outerHTML || ''}`);
        const inReelSettings = element => /cài đặt thước phim|reel settings/i.test(element.closest('[role="dialog"]')?.innerText || '');
        const raw = candidates.find(hasDescriptionHint) || candidates.find(inReelSettings);
        if (!raw) return { ok: false };
        const editor = raw.matches('textarea, [contenteditable="true"]')
          ? raw
          : (raw.querySelector('textarea, [contenteditable="true"]') || raw);
        editor.focus();
        if (shouldClear) {
          if (editor instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter ? setter.call(editor, '') : (editor.value = '');
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
          } else if (editor.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('delete', false);
          }
        }
        return { ok: true };
      }
    });
    return result?.ok === true;
  };

  if (!(await pickAndFocus(true))) throw new Error('Không còn tìm thấy đúng ô Mô tả thước phim để nhập nội dung');
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    for (const character of String(caption).replace(/\r\n/g, '\n')) {
      if (!(await pickAndFocus(false))) throw new Error('Ô Mô tả thước phim đã biến mất trong lúc nhập nội dung');
      if (character === '\n') {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      } else {
        await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: character });
      }
      await variedDelay(110, 210);
    }
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function confirmDescription(tabId, expected) {
  let last = { ok: false, actualLength: 0 };
  // Facebook may replace the textarea shortly after the final input event.
  // Wait for that controlled-component update before deciding it failed.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [expected],
      func: text => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const values = [
          ...[...document.querySelectorAll('textarea')].filter(visible).map(element => element.value),
          ...[...document.querySelectorAll('[contenteditable="true"]')].filter(visible).map(element => element.innerText)
        ];
        const actual = values.find(value => normalize(value).includes(normalize(text))) || values.sort((a, b) => b.length - a.length)[0] || '';
        return { ok: normalize(actual).includes(normalize(text)), actualLength: actual.length };
      }
    });
    last = result || last;
    if (last.ok) return last;
    await variedDelay(450, 850);
  }
  return last;
}

async function waitForReelSettings(tabId, progress) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const body = document.body?.innerText || '';
        const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
        const field = fields.find(element => /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`));
        if (field) return { ready: true, stage: 'settings' };
        const stage = /tạo thước phim|create reel/i.test(body)
          ? 'create'
          : /chỉnh sửa thước phim|edit reel/i.test(body)
            ? 'edit'
            : 'unknown';
        const buttons = [...document.querySelectorAll('[role="button"], button')].filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
        const hasPublishButton = buttons.some(element => [element.innerText, element.getAttribute('aria-label')].filter(Boolean).some(label => /^(đăng|post|publish)$/i.test(label.replace(/\s+/g, ' ').trim())));
        if (/cài đặt thước phim|reel settings/i.test(body) && hasPublishButton) return { ready: true, stage: 'settings' };
        const next = buttons.filter(element => [element.innerText, element.getAttribute('aria-label')].filter(Boolean).some(label => /^(tiếp|next)$/i.test(label.replace(/\s+/g, ' ').trim())))
          .sort((first, second) => second.getBoundingClientRect().bottom - first.getBoundingClientRect().bottom)[0];
        const processing = /kiểm tra.*bản quyền|copyright|đang xử lý video|processing video/i.test(body);
        if (next) {
          next.focus();
          next.click();
          return { ready: false, clicked: true, processing, stage };
        }
        return { ready: false, clicked: false, processing, editing: /chỉnh sửa thước phim|edit reel/i.test(body) };
      }
    });
    if (result?.ready) return;
    if (result?.clicked) {
      const step = result.stage === 'create'
        ? 'Bước 2/4: đã bấm Tiếp ở màn Tạo thước phim'
        : result.stage === 'edit'
          ? 'Bước 3/4: đã bấm Tiếp ở màn Chỉnh sửa thước phim'
          : `Đã thử bấm Tiếp lần ${attempt + 1}`;
      await progress(result.processing
        ? `${step}; video đang kiểm tra bản quyền, đang chờ Facebook chuyển màn`
        : `${step}; đang chờ Facebook chuyển màn`);
    } else if ([0, 3, 7, 10].includes(attempt)) {
      await progress(result?.processing
        ? 'Video đang kiểm tra bản quyền; chờ nút Tiếp sẵn sàng'
        : 'Đang chờ Facebook chuyển sang Cài đặt thước phim');
    }
    await variedDelay(4_500, 6_000);
  }
  throw new Error('Facebook chưa chuyển sang Cài đặt thước phim sau khoảng 1 phút chờ kiểm tra bản quyền');
}

async function trustedClick(tabId, target) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const base = { x: target.x, y: target.y, button: 'left', clickCount: 1 };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function currentReelStage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const text = document.body?.innerText || '';
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const roots = dialogs.length ? dialogs : [document];
      const controls = roots.flatMap(root => [...root.querySelectorAll('[role="button"], button')]).filter(visible);
      const labels = controls.map(element => `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim());
      const isReel = /cài đặt thước phim|chỉnh sửa thước phim|tạo thước phim|reel settings|edit reel|create reel/i.test(text);
      const hasDescription = roots.some(root => [...root.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].some(element => visible(element) && /mô tả.*(thước phim|reel)|describe.*(reel|video)/i.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`)));
      if (isReel && hasDescription && labels.some(label => /^(đăng|post|publish)$/i.test(label))) return 'settings';
      if (isReel && labels.some(label => /^(tiếp|next)$/i.test(label))) return 'editor';
      return '';
    }
  });
  return result || '';
}

async function completeReelSettings(tabId, caption, progress) {
  await progress('Bước 4/4: đã thấy màn Cài đặt thước phim; đang điền Mô tả thước phim');
  const captionResult = await fillCaption(tabId, caption, { reelOnly: true });
  const saved = await confirmDescription(tabId, caption);
  if (!saved.ok) throw new Error(`Chưa xác nhận được tiêu đề, mô tả và hashtag trong ô Mô tả thước phim (đã nhận ${saved.actualLength || 0}/${caption.length} ký tự)`);
  const hasHashtag = /(^|\s)#\S+/.test(caption);
  await progress(captionResult?.target === 'reel-description'
    ? `Đã xác nhận tiêu đề, mô tả${hasHashtag ? ' và hashtag' : ''}; đang bấm Đăng`
    : 'Đã xác nhận caption trong phần cài đặt Reel; đang bấm Đăng');
  await proceedToPublish(tabId, progress);
}

async function checkPostResult(tabId, description, progress) {
  await progress('Đã bấm Đăng, đang kiểm tra phản hồi từ Facebook');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [description],
      func: expected => {
        const text = document.body?.innerText || '';
        if (/captcha|security check|unusual activity|confirm your identity|xác (?:minh|nhận) danh tính/i.test(text)) return { status: 'failed', evidence: 'Facebook đang yêu cầu xác minh/CAPTCHA' };
        const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const pageText = normalize(text);
        const lines = String(expected || '').split(/\r?\n/).map(value => value.trim()).filter(value => value.length >= 6);
        const matched = lines.find(value => pageText.includes(normalize(value)));
        const success = /thước phim.*đã (?:được )?(?:đăng|chia sẻ)|reel.*(?:published|shared)|bài viết.*đã được đăng/i.test(text);
        return matched || success
          ? { status: 'published', evidence: matched ? `Tìm thấy nội dung “${matched.slice(0, 60)}” trên Page` : 'Facebook hiển thị thông báo đã đăng' }
          : { status: 'waiting' };
      }
    });
    if (result?.status === 'published' || result?.status === 'failed') return result;
    if (attempt < 4) await delay(4_000);
  }
  return { status: 'needs_review', evidence: 'Facebook chưa trả xác nhận trong thời gian chờ. Bài có thể đang xử lý; A không báo thành công khi chưa có bằng chứng.' };
}

async function proceedToPublish(tabId, onProgress, { stopAfterNext = false } = {}) {
  let nextSteps = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || '';
        if (/captcha|security check|unusual activity|confirm your identity|verification required|enter (?:the )?security code|xác (?:minh|nhận) danh tính|hoàn tất kiểm tra bảo mật|nhập mã bảo mật/i.test(text)) return { error: 'Facebook đang yêu cầu xác minh/CAPTCHA' };
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const enabled = element => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
        const roots = dialogs.length ? dialogs : [document];
        const controls = roots.flatMap(root => [...root.querySelectorAll('[role="button"], button')]).filter(element => visible(element) && enabled(element));
        const labelsOf = element => [element.innerText, element.getAttribute('aria-label')].filter(Boolean).map(value => value.replace(/\s+/g, ' ').trim());
        const hasLabel = (element, expression) => labelsOf(element).some(label => expression.test(label));
        const lowest = candidates => [...candidates].sort((first, second) => second.getBoundingClientRect().bottom - first.getBoundingClientRect().bottom)[0];
        const pointOf = element => {
          const rect = element.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        };
        const post = lowest(controls.filter(element => hasLabel(element, /^(đăng|post|publish)$/i)));
        if (post) {
          post.focus();
          post.click();
          return { action: 'posted', ...pointOf(post) };
        }
        const next = lowest(controls.filter(element => hasLabel(element, /^(tiếp|next)$/i)));
        if (next) {
          next.focus();
          next.click();
          return { action: 'next', ...pointOf(next) };
        }
        return { action: 'waiting' };
      }
    });
    if (result?.error) throw new Error(result.error);
    if (result?.action === 'posted') {
      await onProgress('Đã bấm Đăng, đang chờ Facebook xác nhận');
      return;
    }
    if (result?.action === 'next') {
      nextSteps += 1;
      await onProgress(`Đã bấm Tiếp (${nextSteps})`);
      if (stopAfterNext) return 'next';
    }
    if (result?.action === 'waiting' && [5, 15, 25].includes(attempt)) await onProgress('Đang chờ Facebook xử lý video');
    await variedDelay(result?.action === 'next' ? 900 : 850, result?.action === 'next' ? 1_650 : 1_350);
  }
  throw new Error('Video chưa sẵn sàng hoặc không tìm thấy nút Tiếp/Đăng');
}

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('Facebook tải quá lâu')); }, 20_000);
    const listener = (updatedId, change) => {
      if (updatedId === tabId && change.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Mỗi Chrome Profile tương ứng một Page. Khi Page bắt đầu đăng, chỉ giữ tab Page
// sạch đang dùng để tiết kiệm tài nguyên và tránh tab Facebook khác gây nhiễu.
async function keepOnlyPostingTab(tabId) {
  const tabs = await chrome.tabs.query({});
  const otherTabIds = tabs
    .filter(tab => Number.isInteger(tab.id) && tab.id !== tabId)
    .map(tab => tab.id);
  if (otherTabIds.length) await chrome.tabs.remove(otherTabIds);
  return otherTabIds.length;
}

function postingPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return rawUrl;
    const segments = url.pathname.split('/').filter(Boolean);
    const reelAt = segments.findIndex(segment => /^(?:reels?|videos?)$/i.test(segment));
    // A URL ending in /reels is a viewing feed, not the Page home that holds
    // the Ảnh/video and Thước phim buttons used to begin a publication.
    if (reelAt > 0) url.pathname = `/${segments.slice(0, reelAt).join('/')}/`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return rawUrl;
  }
}

async function pageTab(url, { fresh = false } = {}) {
  if (!url) throw new Error('Bài trong Drive chưa có URL Facebook Page');
  const postingUrl = postingPageUrl(url);
  // Posting must never reload a Page tab where the user may have an unsaved
  // Facebook draft. A new tab is clean and avoids Chrome's "Tải lại trang web?"
  // confirmation, while leaving the user's original tab untouched.
  if (fresh) {
    const tab = await chrome.tabs.create({ url: postingUrl, active: true });
    await waitForTab(tab.id);
    return tab;
  }
  let tab = await facebookTab();
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: postingUrl, active: true });
    await waitForTab(tab.id);
  }
  else {
    const canonical = value => String(value || '').replace(/\/+$/, '').toLowerCase();
    const loaded = waitForTab(tab.id);
    if (canonical(tab.url) !== canonical(postingUrl)) {
      tab = await chrome.tabs.update(tab.id, { url: postingUrl, active: true });
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.reload(tab.id, { bypassCache: false });
    }
    await loaded;
  }
  return tab;
}

async function openVideoCreator(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = document.body?.innerText || '';
      if (/captcha|security check|unusual activity|confirm your identity|verification required|enter (?:the )?security code|xác (?:minh|nhận) danh tính|hoàn tất kiểm tra bảo mật|nhập mã bảo mật/i.test(text)) return { error: 'Facebook đang yêu cầu xác minh/CAPTCHA' };
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const controls = [...document.querySelectorAll('[role="button"], button')].filter(visible);
      const labelsOf = element => [element.innerText, element.getAttribute('aria-label')].filter(Boolean).map(value => value.replace(/\s+/g, ' ').trim());
      const hasLabel = (element, expression) => labelsOf(element).some(label => expression.test(label));
      // Video posts must start in the Reel workflow, not the general text composer.
      const action = controls.find(element => hasLabel(element, /^(thước phim|reels?)$/i))
        || controls.find(element => hasLabel(element, /^(ảnh\s*\/\s*video|photo\s*\/\s*video)$/i));
      if (!action) return { error: 'Không tìm thấy nút Ảnh/video hoặc Thước phim trên Page' };
      const label = labelsOf(action)[0];
      action.click();
      return { ok: true, label };
    }
  });
  if (result?.error) throw new Error(result.error);
  if (!result?.ok) throw new Error('Không mở được màn hình tải video');
  return result.label;
}

async function attachMediaFile(tabId, filePath, progress = null) {
  let marked = false;
  for (let attempt = 0; attempt < 10 && !marked; attempt += 1) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        document.querySelectorAll('[data-b-upload-target="true"]').forEach(element => element.removeAttribute('data-b-upload-target'));
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
        const roots = dialogs.length ? dialogs : [document];
        const inputs = roots.flatMap(root => [...root.querySelectorAll('input[type="file"]')]);
        const target = inputs.find(input => /video|image/i.test(input.accept || '')) || inputs[0];
        if (!target) return { waiting: true };
        target.setAttribute('data-b-upload-target', 'true');
        return { ok: true };
      }
    });
    marked = Boolean(result?.ok);
    if (!marked) await delay(500);
  }
  if (!marked) throw new Error('Không tìm thấy ô tải file trong màn hình Ảnh/video hoặc Thước phim');

  if (progress) await progress('Đã tìm thấy ô tải video, đang gắn file vào Facebook');
  let uploadError = null;
  let debuggerAttached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    const selected = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'document.querySelector(\'input[data-b-upload-target="true"]\')',
      objectGroup: 'b-upload',
      returnByValue: false
    });
    if (!selected.result?.objectId) throw new Error('Không xác định được ô tải file đang mở');
    try {
      await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { files: [filePath], objectId: selected.result.objectId });
    } catch (firstError) {
      // Use the standard DevTools DOM flow for the retry. This avoids the
      // temporary JavaScript object Facebook can discard while rendering the
      // uploader and is the same nodeId route documented by Chrome.
      if (progress) await progress('Chrome từ chối lượt gắn file đầu tiên, đang lấy lại đúng ô tải video theo DOM và thử lại');
      await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
      const documentRoot = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1, pierce: true });
      const located = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: documentRoot.root.nodeId,
        selector: 'input[data-b-upload-target="true"]'
      });
      if (!located?.nodeId) throw firstError;
      await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', { nodeId: located.nodeId }).catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { files: [filePath], nodeId: located.nodeId });
      await chrome.debugger.sendCommand({ tabId }, 'DOM.disable').catch(() => {});
    }
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObjectGroup', { objectGroup: 'b-upload' }).catch(() => {});
  } catch (error) {
    uploadError = error;
  } finally {
    if (debuggerAttached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  if (!uploadError) {
    if (progress) await progress('Đã gắn video vào ô tải lên Facebook');
    return;
  }
  if (!/not allowed/i.test(String(uploadError?.message || uploadError))) throw uploadError;
  if (progress) await progress('Chrome chặn extension gắn file; A đang gắn video qua kênh trực tiếp AdsPower');
  try {
    await attachMediaFileViaA(tabId, filePath);
  } catch (directError) {
    throw new Error(`Không gắn được video qua AdsPower: ${directError.message || directError}`);
  }
  if (progress) await progress('A đã gắn video qua AdsPower, Facebook đang nhận file');
}

async function postFromDrive(job) {
  const postId = job?.postId || 'không rõ mã bài';
  const outcome = { postId, at: new Date().toISOString() };
  const progress = async message => { try { await event(`POST ${postId} · ${message}`); } catch (_) {} };
  try {
    const description = descriptionFor(job);
    if (!job?.mediaPath || !description) throw new Error('Bài Drive thiếu video/ảnh hoặc caption');
    await progress('Đã nhận lệnh đăng ngay');
    await progress('Đang mở tab Page sạch theo link trong Drive');
    const tab = await pageTab(job.pageUrl, { fresh: true });
    const closedTabs = await keepOnlyPostingTab(tab.id);
    await progress(closedTabs ? `Đã đóng ${closedTabs} tab khác trong Profile; chỉ giữ tab đăng bài` : 'Profile chỉ có tab đăng bài');
    await progress('Tab Page sạch đã tải xong, bắt đầu quy trình đăng Reel');
    await variedDelay(900, 1_700);
    const existingReelStage = await currentReelStage(tab.id);
    if (existingReelStage === 'settings') {
      await completeReelSettings(tab.id, description, progress);
      const result = await checkPostResult(tab.id, description, progress);
      outcome.status = result.status;
      outcome.error = result.status === 'published' ? '' : result.evidence;
      await event(result.status === 'published' ? `Đã xác nhận đăng thành công ${job.postId}: ${result.evidence}` : `Chưa đăng/xác nhận được ${job.postId}: ${result.evidence}`, result.status === 'published' ? 'success' : 'error', { postOutcome: outcome });
      return;
    }
    const creator = await openVideoCreator(tab.id);
    await progress(`Đã bấm ${creator}`);
    await variedDelay(1_100, 2_000);
    await progress('Bước 1/4: đang tải video từ Drive lên Thước phim');
    await attachMediaFile(tab.id, job.mediaPath, progress);
    await variedDelay(1_300, 2_600);
    const isReel = /thước phim|reel/i.test(creator);
    if (isReel) {
      await progress('Bước 1/4 hoàn tất: video đã lên Reel; đang đi lần lượt qua hai nút Tiếp');
      await waitForReelSettings(tab.id, progress);
      await completeReelSettings(tab.id, description, progress);
    } else {
      await progress('Đã gắn video, đang điền caption và hashtag');
      await fillCaption(tab.id, description);
      await progress('Đã điền caption, đang tìm nút Tiếp');
      await proceedToPublish(tab.id, progress);
    }
    const result = await checkPostResult(tab.id, description, progress);
    outcome.status = result.status;
    outcome.error = result.status === 'published' ? '' : result.evidence;
    await event(result.status === 'published' ? `Đã xác nhận đăng thành công ${job.postId}: ${result.evidence}` : `Chưa đăng/xác nhận được ${job.postId}: ${result.evidence}`, result.status === 'published' ? 'success' : 'error', { postOutcome: outcome });
  } catch (error) {
    outcome.status = 'failed';
    outcome.error = error.message;
    await event(`Không đăng được ${job.postId}: ${error.message}`, 'error', { postOutcome: outcome });
  }
}

async function execute(command) {
  if (command.type === 'check_source') return checkSource();
  if (command.type === 'post_next') return postFromDrive(command.job);
  if (command.type === 'open_facebook') {
    await chrome.tabs.create({ url: 'https://www.facebook.com/' });
    return event('Page đã mở Facebook');
  }

  const tab = await facebookTab();
  if (!tab?.id) return event(`Không thể thực hiện ${command.type}: chưa có tab Facebook`, 'error');
  if (command.type === 'refresh_page') {
    const snapshot = await reportPage(tab);
    return event(
      snapshot.ok ? `Page đã cập nhật Facebook${snapshot.page.name ? `: ${snapshot.page.name}` : ''}; không tải lại tab Facebook` : 'Page không đọc được thông tin Facebook; không tải lại tab Facebook',
      snapshot.ok ? 'success' : 'error',
      snapshot.ok ? { page: snapshot.page } : {}
    );
  }
  if (command.type === 'scroll_down') {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: 'smooth' }) });
    return event('Page đã cuộn xuống theo lệnh từ A');
  }
  if (command.type === 'pause') return event('Page đã nhận lệnh tạm dừng');
}

async function heartbeat() {
  const { serverUrl, pageId } = await config();
  if (!pageId) return;
  try {
    let page;
    // Every browser profile receives its own Page number from A on manual Connect.
    if (Date.now() - lastSnapshotAt > 60_000) {
      const tab = await facebookTab();
      if (tab?.id) {
        const snapshot = await reportPage(tab);
        if (snapshot.ok) {
          page = snapshot.page;
          lastSnapshotAt = Date.now();
        }
      }
    }
    const response = await fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Page đang online', ...(page ? { page } : {}) })
    });
    if (!response.ok) return;
    const { commands } = await (await fetch(`${serverUrl}/api/bots/${encodeURIComponent(pageId)}/commands`)).json();
    for (const command of commands) {
      try {
        await execute(command);
      } catch (error) {
        await event(`Không thực hiện được lệnh ${command.type}: ${error.message || 'lỗi không xác định'}`, 'error');
      }
    }
  } catch (_) {
    // A có thể đang offline; extension sẽ thử lại ở nhịp tiếp theo.
  }
}

chrome.runtime.onInstalled.addListener(heartbeat);
chrome.runtime.onStartup.addListener(heartbeat);
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'connect_now') heartbeat();
});
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(heartbeat);
setInterval(heartbeat, 15000);
