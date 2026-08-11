(() => {
  const enhanceThinking = root => {
    root.querySelectorAll?.('.thinking span').forEach(label => {
      const nextLabel = 'Thinking through the next step…';
      if (label.textContent !== nextLabel) label.textContent = nextLabel;
    });
  };

  const start = () => {
    const messages = document.getElementById('messages');
    if (!messages) return;
    enhanceThinking(messages);
    new MutationObserver(() => enhanceThinking(messages)).observe(messages, {
      childList: true,
      subtree: true
    });
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
