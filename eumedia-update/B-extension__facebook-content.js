chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'scroll_down') {
    window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: 'smooth' });
    return;
  }
  if (message.type === 'page_snapshot') {
    const text = document.body?.innerText || '';
    const readNumber = pattern => {
      const match = text.match(pattern);
      return match ? Number(match[1].replace(/[^0-9]/g, '')) : undefined;
    };
    const name = document.querySelector('h1')?.innerText?.trim()
      || document.title.replace(/\s*\|.*$/, '').trim();
    return Promise.resolve({
      name,
      followers: readNumber(/([0-9.,\s]+)\s*(?:người theo dõi|followers)/i),
      publishedPosts: readNumber(/([0-9.,\s]+)\s*(?:bài viết|posts)/i)
    });
  }
});
