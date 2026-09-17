'use strict';
// 把 Node 已解析的出站代理套到 Chromium session（含 persist 分区）。
const { chromiumProxySettings } = require('../shared/inject-proxy-env');

async function applySessionProxy(ses, label) {
  if (!ses || typeof ses.setProxy !== 'function') return null;
  const cfg = chromiumProxySettings();
  await ses.setProxy(cfg);
  if (label) {
    console.log('[chromium-proxy]', label, cfg.proxyRules || cfg.mode || 'system');
  }
  return cfg;
}

module.exports = { applySessionProxy };
