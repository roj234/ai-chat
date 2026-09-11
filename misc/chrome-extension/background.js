// CORS Disabler — background service worker
// 根据配置生成 declarativeNetRequest 会话规则：
//   - 对配置的源（按主机分组）注入 CORS 响应头；
//   - 同一主机配置了多个不同端口的源时，自动改用 Access-Control-Allow-Origin: *；
//   - 可选：给「配置源的页面文档」注入 Referrer-Policy: no-referrer 以去掉 Referer。
'use strict';

const RULE_BASE_ID = 1000000;

const DEFAULT_SETTINGS = {
  enabled: true,
  allowCredentials: false,
  wildcardOrigin: false,
  allowMethods: '*',
  allowHeaders: '*',
  exposeHeaders: '*',
  targetDomains: [],
  removeReferer: false,
  setReferrerToOrigin: false // Chrome 禁止扩展修改 Referer 头，此选项无法生效，仅保留提示。
};

function normalizeSettings(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

// 兼容 "http://127.0.0.1:8080"、"127.0.0.1:8080"、"localhost:3000" 等写法。
function parseOrigin(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname) return null;
    return { host: u.hostname, origin: u.origin };
  } catch {
    return null;
  }
}

async function getConfig() {
  const data = await chrome.storage.local.get({ origins: [], settings: DEFAULT_SETTINGS });
  return {
    origins: Array.isArray(data.origins) ? data.origins : [],
    settings: normalizeSettings(data.settings)
  };
}

// 按主机分组，得到每个 host 下的所有源字符串。
function groupByHost(parsed) {
  const m = new Map();
  for (const p of parsed) {
    if (!m.has(p.host)) m.set(p.host, []);
    m.get(p.host).push(p.origin);
  }
  return m;
}

// 决定某主机对应的 Access-Control-Allow-Origin 取值。
function decideAcao(host, originList, settings, warnings) {
  const multi = originList.length > 1; // 同一主机下是否有多个不同端口源

  // 凭据模式下不能用通配符 *，必须回到具体源。
  if (settings.allowCredentials) {
    if (multi) {
      warnings.push(
        `主机 ${host} 下配置了 ${originList.length} 个不同端口的源，且开启了「允许凭据」。` +
          `通配符 * 与凭据模式不兼容，因此只会放行 ${originList[0]}，同主机其它端口可能互相覆盖。` +
          `建议只保留一个源，或关闭「允许凭据」。`
      );
    }
    return originList[0];
  }

  // 同一主机下多个不同端口 → 用 * 放行整个主机。
  if (multi) {
    warnings.push(
      `主机 ${host} 下配置了 ${originList.length} 个不同端口的源，已自动改用 Access-Control-Allow-Origin: * 放行该主机全部端口。`
    );
    return '*';
  }

  // 单个源：用户显式要求通配，或写具体源。
  if (settings.wildcardOrigin) return '*';
  return originList[0];
}

async function updateRules() {
  const { origins, settings } = await getConfig();
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];
  const warnings = [];

  if (settings.enabled) {
    const parsed = origins
      .filter((o) => o.enabled !== false)
      .map((o) => parseOrigin(o.url))
      .filter(Boolean);
    const byHost = groupByHost(parsed);
    const targets = (settings.targetDomains || []).map((s) => String(s).trim()).filter(Boolean);
    let nextId = RULE_BASE_ID;

    // 1) CORS 规则：每条主机一条，注入 CORS 响应头。
    for (const [host, originList] of byHost) {
      const acao = decideAcao(host, originList, settings, warnings);

      const responseHeaders = [
        { header: 'Access-Control-Allow-Origin', operation: 'set', value: acao },
        { header: 'Access-Control-Allow-Methods', operation: 'set', value: settings.allowMethods },
        { header: 'Access-Control-Allow-Headers', operation: 'set', value: settings.allowHeaders },
        { header: 'Access-Control-Expose-Headers', operation: 'set', value: settings.exposeHeaders }
      ];
      if (settings.allowCredentials) {
        responseHeaders.push({ header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' });
      }

      const condition = { initiatorDomains: [host] };
      if (targets.length) condition.requestDomains = targets; // 只对指定目标域名生效

      addRules.push({
        id: nextId++,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders },
        condition
      });
    }

    // 2) 去掉 Referer：给「配置源自己的页面文档」注入 Referrer-Policy: no-referrer，
    //    这样该页面发起的请求就不再携带 Referer。这是 MV3 下可行的做法。
    if (settings.removeReferer) {
      for (const [host] of byHost) {
        addRules.push({
          id: nextId++,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'Referrer-Policy', operation: 'set', value: 'no-referrer' }]
          },
          condition: {
            requestDomains: [host],
            resourceTypes: ['main_frame', 'sub_frame']
          }
        });
      }
    }

    // 3) 把 Referer 设为目标同源根：DNR 不允许修改 Referer 头（属受限敏感头），无法实现。
    if (settings.setReferrerToOrigin) {
      warnings.push(
        '「把 Referer 设为目标域名同源根」在当前 MV3 DNR 方案下不可用：' +
          'Chrome 禁止扩展通过 declarativeNetRequest 修改 Referer 请求头。'
      );
    }
  }

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  return warnings;
}

// 串行化更新，避免 service worker 重启时的竞态。
let queue = Promise.resolve();
function scheduleUpdate() {
  queue = queue
    .then(() => updateRules())
    .then((warnings) => {
      if (warnings && warnings.length) {
        console.warn('[CORS Disabler]', warnings.join('\n'));
        chrome.storage.local.set({ lastWarnings: warnings });
      } else {
        chrome.storage.local.set({ lastWarnings: [] });
      }
    })
    .catch((err) => console.error('updateRules failed:', err));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.origins || changes.settings)) scheduleUpdate();
});

chrome.runtime.onInstalled.addListener(() => scheduleUpdate());
chrome.runtime.onStartup.addListener(() => scheduleUpdate());

// service worker 启动时也重建一次。
scheduleUpdate();
