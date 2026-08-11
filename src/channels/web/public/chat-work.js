(() => {
  const initialize = () => {
    const messages = document.getElementById('messages');
    const activityList = document.getElementById('activityList');
    const terminal = document.getElementById('terminal');
    const artifactList = document.getElementById('artifactList');
    if (!messages || !activityList || !terminal || !artifactList) return false;

    const cards = new Map();
    let activeCard = null;
    let terminalSnapshot = terminal.textContent || '';

    const scrollToLatest = () => {
      requestAnimationFrame(() => {
        messages.scrollTop = messages.scrollHeight;
      });
    };

    const createCard = (id, label) => {
      const article = document.createElement('article');
      article.className = 'message assistant work-message';
      article.dataset.inlineWork = id;

      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = '↯';

      const details = document.createElement('details');
      details.className = 'work-card running';
      details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'work-summary';
      const indicator = document.createElement('span');
      indicator.className = 'work-indicator';
      const name = document.createElement('span');
      name.className = 'work-label';
      name.textContent = label || 'Working';
      const status = document.createElement('span');
      status.className = 'work-state';
      status.textContent = 'running';
      summary.append(indicator, name, status);

      const output = document.createElement('pre');
      output.className = 'work-output';
      output.textContent = 'Starting…';
      details.append(summary, output);
      article.append(role, details);
      messages.appendChild(article);

      const card = { article, details, name, status, output };
      cards.set(id, card);
      activeCard = card;
      scrollToLatest();
      return card;
    };

    const syncActivity = element => {
      if (!(element instanceof HTMLElement) || !element.classList.contains('activity')) return;
      const label = element.querySelector('.activity-name')?.textContent?.trim()
        || element.querySelector('.activity-top span')?.textContent?.trim()
        || 'Agent work';
      if (label.toLowerCase() === 'ready') return;
      const id = element.dataset.activity || `work-${Date.now()}`;
      const statusText = element.querySelector('.activity-state')?.textContent?.trim() || 'running';
      const normalizedStatus = element.classList.contains('failed') ? 'failed'
        : statusText.toLowerCase() === 'running' ? 'running' : 'completed';
      const card = cards.get(id) || createCard(id, label);
      card.name.textContent = label;
      card.status.textContent = normalizedStatus;
      card.details.className = `work-card ${normalizedStatus}`;
      const output = element.querySelector('pre')?.textContent?.trim();
      if (output) card.output.textContent = output;
      if (normalizedStatus === 'running') {
        card.details.open = true;
        activeCard = card;
      } else {
        card.details.open = normalizedStatus === 'failed';
        if (activeCard === card) activeCard = null;
      }
      scrollToLatest();
    };

    const activityObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const candidate = mutation.target instanceof HTMLElement
          ? mutation.target.closest('.activity')
          : null;
        if (candidate) syncActivity(candidate);
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          if (node.classList.contains('activity')) syncActivity(node);
          node.querySelectorAll?.('.activity').forEach(syncActivity);
        });
      }
    });
    activityObserver.observe(activityList, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });

    const terminalObserver = new MutationObserver(() => {
      const current = terminal.textContent || '';
      const delta = current.startsWith(terminalSnapshot)
        ? current.slice(terminalSnapshot.length)
        : current;
      terminalSnapshot = current;
      if (!delta.trim()) return;
      const card = activeCard || createCard(`terminal-${Date.now()}`, 'Command output');
      const existing = card.output.textContent === 'Starting…' ? '' : card.output.textContent;
      card.output.textContent = `${existing}${delta}`.slice(-12000);
      card.details.open = true;
      scrollToLatest();
    });
    terminalObserver.observe(terminal, { childList: true, subtree: true, characterData: true });

    const artifactObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement) || !node.classList.contains('artifact')) return;
          const card = createCard(`artifact-${Date.now()}`, 'Artifact created');
          card.status.textContent = 'completed';
          card.details.className = 'work-card completed';
          card.output.remove();
          const link = document.createElement('a');
          link.className = 'work-artifact';
          link.href = node.getAttribute('href') || '#';
          link.target = '_blank';
          link.rel = 'noopener';
          link.innerHTML = node.innerHTML;
          card.details.appendChild(link);
          card.details.open = true;
          activeCard = null;
          scrollToLatest();
        });
      }
    });
    artifactObserver.observe(artifactList, { childList: true });
    return true;
  };

  if (!initialize()) {
    window.addEventListener('DOMContentLoaded', initialize, { once: true });
  }
})();
