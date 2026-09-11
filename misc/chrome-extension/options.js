'use strict';

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  enabled: true,
  allowCredentials: false,
  wildcardOrigin: false,
  allowMethods: '*',
  allowHeaders: '*',
  exposeHeaders: '*',
  targetDomains: [],
};

async function load() {
  const data = await chrome.storage.local.get({ origins: [], settings: DEFAULT_SETTINGS });
  return {
    origins: data.origins || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }
  };
}

// 规范化源 → 完整 origin（无路径）。
function normalizeUrl(s) {
  let t = s;
  if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
  try {
    return new URL(t).origin;
  } catch {
    return '';
  }
}

// 规范化目标域名 → hostname（不含协议、路径、端口）。
function normalizeDomain(s) {
  let t = s;
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  try {
    return new URL(t).hostname;
  } catch {
    return '';
  }
}

function renderOrigins(origins) {
  const list = $('#origins-list');
  list.innerHTML = '';
  origins.forEach((o) => {
    const row = document.createElement('div');
    row.className = 'origin-row';
    row.dataset.id = o.id || '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = o.enabled !== false;
    cb.title = '启用该源';

    const url = document.createElement('input');
    url.type = 'text';
    url.value = o.url || '';
    url.placeholder = 'http://127.0.0.1:8080';

    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'danger';
    del.title = '删除';
    del.addEventListener('click', () => {
      const i = origins.indexOf(o);
      if (i >= 0) origins.splice(i, 1);
      renderOrigins(origins);
    });

    row.appendChild(cb);
    row.appendChild(url);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderSettings(s) {
  $('#enabled').checked = s.enabled;
  $('#allow-credentials').checked = s.allowCredentials;
  $('#wildcard-origin').checked = s.wildcardOrigin;
  $('#allow-methods').value = s.allowMethods;
  $('#allow-headers').value = s.allowHeaders;
  $('#expose-headers').value = s.exposeHeaders;
  $('#target-domains').value = (s.targetDomains || []).join(', ');
}

function readOrigins() {
  return Array.from(document.querySelectorAll('#origins-list .origin-row'))
    .map((row) => {
      const id = row.dataset.id;
      const url = normalizeUrl(row.querySelector('input[type=text]').value);
      const enabled = row.querySelector('input[type=checkbox]').checked;
      return { id: id || crypto.randomUUID(), url, enabled };
    })
    .filter((o) => o.url);
}

// 保存前计算可能出现的警告。
function computeWarnings(origins, settings) {
  const warns = [];
  const byHost = new Map();
  for (const o of origins) {
    let u;
    try {
      u = new URL(o.url);
    } catch {
      continue;
    }
    const host = u.hostname;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(u.origin);
  }
  for (const [host, list] of byHost) {
    if (list.length > 1) {
      if (settings.allowCredentials) {
        warns.push(
          `主机 ${host} 下有 ${list.length} 个不同端口的源，且开启了「允许凭据」。` +
            `通配符 * 与凭据模式不兼容，因此只会放行 ${list[0]}，同主机其它端口可能互相覆盖。` +
            `建议只保留一个源，或关闭「允许凭据」。`
        );
      } else {
        warns.push(`主机 ${host} 下有 ${list.length} 个不同端口的源，将自动使用 Access-Control-Allow-Origin: * 放行该主机全部端口。`);
      }
    }
  }
  return warns;
}

function showWarnings(warns) {
  const el = $('#warnings');
  if (!warns.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = warns.map((w) => `<p>⚠ ${w}</p>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  const { origins, settings } = await load();
  renderOrigins(origins);
  renderSettings(settings);

  $('#add-origin').addEventListener('click', () => {
    const val = $('#new-origin').value.trim();
    if (!val) return;
    const normalized = normalizeUrl(val);
    if (!normalized) {
      alert('无效的源地址');
      return;
    }
    origins.push({ id: crypto.randomUUID(), url: normalized, enabled: true });
    $('#new-origin').value = '';
    renderOrigins(origins);
  });

  $('#save').addEventListener('click', async () => {
    const settingsOut = {
      enabled: $('#enabled').checked,
      allowCredentials: $('#allow-credentials').checked,
      wildcardOrigin: $('#wildcard-origin').checked,
      allowMethods: $('#allow-methods').value.trim() || '*',
      allowHeaders: $('#allow-headers').value.trim() || '*',
      exposeHeaders: $('#expose-headers').value.trim() || '*',
      targetDomains: $('#target-domains').value.split(',').map(normalizeDomain).filter(Boolean),
    };
    const originsOut = readOrigins();

    await chrome.storage.local.set({ origins: originsOut, settings: settingsOut });

    const st = $('#status');
    st.textContent = '已保存 ✓';
    setTimeout(() => (st.textContent = ''), 1600);

    showWarnings(computeWarnings(originsOut, settingsOut));
  });
});
