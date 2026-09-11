'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  allowCredentials: false,
  wildcardOrigin: false,
  allowMethods: '*',
  allowHeaders: '*',
  exposeHeaders: '*',
  targetDomains: [],
};

async function getData() {
  return await chrome.storage.local.get({ origins: [], settings: DEFAULT_SETTINGS });
}

async function render() {
  const { origins, settings } = await getData();
  document.getElementById('global-enabled').checked = settings.enabled;

  const container = document.getElementById('origins');
  container.innerHTML = '';
  if (!origins.length) {
    container.innerHTML = '<div class="muted">No origins configured.</div>';
    return;
  }

  origins.forEach((o, i) => {
    const row = document.createElement('div');
    row.className = 'origin-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = o.enabled !== false;
    cb.addEventListener('change', async () => {
      const d = await getData();
      d.origins[i].enabled = cb.checked;
      await chrome.storage.local.set({ origins: d.origins });
      render();
    });

    const span = document.createElement('span');
    span.className = 'url';
    span.textContent = o.url;

    row.appendChild(cb);
    row.appendChild(span);
    container.appendChild(row);
  });
}

function setStatus(t) {
  const el = document.getElementById('status');
  el.textContent = t;
  setTimeout(() => (el.textContent = ''), 2200);
}

document.addEventListener('DOMContentLoaded', () => {
  render();

  document.getElementById('global-enabled').addEventListener('change', async (e) => {
    const d = await getData();
    d.settings.enabled = e.target.checked;
    await chrome.storage.local.set({ settings: d.settings });
  });

  document.getElementById('add-current').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab && tab.url;
    if (url && /^https?:/i.test(url)) {
      const origin = new URL(url).origin;
      const d = await getData();
      if (d.origins.some((o) => o.url === origin)) {
        setStatus('Already added.');
      } else {
        d.origins.push({ id: crypto.randomUUID(), url: origin, enabled: true });
        await chrome.storage.local.set({ origins: d.origins });
        setStatus('Added ' + origin);
      }
      render();
    } else {
      setStatus('只支持 http(s) 来源的页面.');
    }
  });

  document.getElementById('open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
