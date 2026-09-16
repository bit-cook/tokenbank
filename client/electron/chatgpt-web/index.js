// index.js — ChatGPT 网页源编排层：起本地 Responses server + 把 provider.token 写进 agent config + IPC。
// main.js 只需 require 本模块调 registerIpc / maybeStart，改动最小。
const server = require('./server');
const host = require('./host');

const PROVIDER_ID = 'chatgpt-web';

let deps = { readAgentConfig: null, writeAgentConfig: null };

function log(...a) { console.log('[chatgpt-web]', ...a); }

// 是否已启用（用户在 GUI 勾选后落到 agent config 的 provider.enabled）
function isEnabled() {
  try {
    const cfg = deps.readAgentConfig?.() || {};
    const p = (cfg.providers || []).find((x) => x && x.id === PROVIDER_ID);
    return !!(p && p.enabled);
  } catch { return false; }
}

// 把本地 server 的 base_url + bearer 写进 agent config 的 provider（网关据此注入 Authorization）。
// enable 省略时保留条目原有 enabled（开机补正用）；显式传 true/false 时覆盖（用户启用/禁用用）。
function upsertProvider({ port, token }, { enable } = {}) {
  const read = deps.readAgentConfig, write = deps.writeAgentConfig;
  if (!read || !write) return;
  const cfg = read() || {};
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const base = `http://127.0.0.1:${port}`;
  const models = server.status().models.map((m) => ({ name: m, type: 'chat' }));
  const patch = {
    id: PROVIDER_ID,
    label: 'ChatGPT 网页',
    // type=free：可路由 tier（网关按 p.type===requestTier 过滤），且非 paid → 不被 migrateAgentProviders 清理
    type: 'free',
    handler: 'openai',
    api_format: 'responses',
    supports_responses: true,
    base_url: base,
    token,                    // 本地 bearer；网关 local-gateway.js:1140 注入 Authorization
    local_only: true,
    experimental: true,
  };
  const i = providers.findIndex((x) => x && x.id === PROVIDER_ID);
  if (i >= 0) {
    const prevEnabled = providers[i].enabled;
    // 保留已有模型（用户可能选过），无则给默认
    const prevModels = Array.isArray(providers[i].models) && providers[i].models.length ? providers[i].models : models;
    providers[i] = { ...providers[i], ...patch, models: prevModels,
      enabled: enable === undefined ? prevEnabled : !!enable };
  } else {
    providers.push({ ...patch, models, enabled: !!enable });
  }
  cfg.providers = providers;
  write(cfg);
  log('已写入 provider', base, 'enabled=', providers.find((x) => x.id === PROVIDER_ID)?.enabled);
}

// 启动本地 server（幂等）+ 回写 provider。opts.enable 传给 upsertProvider。不开浏览器窗口（登录时才开）。
async function start(opts = {}) {
  const st = await server.start();
  upsertProvider(st, opts);
  return st;
}

// 存在 chatgpt-web 条目 = 用户加过 → 起 server 并补正 base_url/token/type（保留 enabled）
function hasEntry() {
  try {
    const cfg = deps.readAgentConfig?.() || {};
    return (cfg.providers || []).some((x) => x && x.id === PROVIDER_ID);
  } catch { return false; }
}

function stop() {
  server.stop();
  host.hideLogin();
}

// 开机：只要用户加过 chatgpt-web 条目，就起 server 并补正 base_url/token/type（保留 enabled）。
// 没加过则完全不动（不占端口、不开浏览器）。server 仅是 loopback http，浏览器窗口只在登录时才开。
async function maybeStart() {
  if (!hasEntry()) { log('无条目，跳过自启'); return; }
  try { await start(); log(isEnabled() ? '已补正并就绪' : '已补正（当前禁用）'); }
  catch (e) { log('自启失败', e.message); }
}

function registerIpc(ipcMain, injected) {
  deps = { ...deps, ...injected };
  ipcMain.handle('chatgptweb:status', async () => {
    const st = server.status();
    let loggedIn = false;
    if (st.running) { try { loggedIn = await host.isLoggedIn(); } catch {} }
    return { ...st, enabled: isEnabled(), loggedIn };
  });
  ipcMain.handle('chatgptweb:start', async () => start({ enable: true }));
  ipcMain.handle('chatgptweb:stop', async () => { stop(); return { ok: true }; });
  ipcMain.handle('chatgptweb:login', async () => { await start({ enable: true }); await host.showLogin(); return { ok: true }; });
  ipcMain.handle('chatgptweb:hideLogin', async () => { host.hideLogin(); return { ok: true }; });
  ipcMain.handle('chatgptweb:conn', async () => {
    const st = server.status();
    return { port: st.port, endpoint: st.port ? `http://127.0.0.1:${st.port}` : null,
      tokenMasked: st.token ? st.token.slice(0, 8) + '…' : null };
  });
  // 打一发 ping（走本地 server → host → 你自己的 ChatGPT）
  ipcMain.handle('chatgptweb:test', async () => {
    try {
      const out = await host.runTurn('用一句话回复：ok', { overallTimeoutMs: 60000 });
      return { ok: true, text: out.text };
    } catch (e) { return { ok: false, code: e.code || 'error', message: e.message }; }
  });
  // 禁用：停 server + 把 provider.enabled 置 false
  ipcMain.handle('chatgptweb:disable', async () => {
    stop();
    try {
      const cfg = deps.readAgentConfig?.() || {};
      const p = (cfg.providers || []).find((x) => x && x.id === PROVIDER_ID);
      if (p) { p.enabled = false; deps.writeAgentConfig?.(cfg); }
    } catch {}
    return { ok: true };
  });
}

module.exports = { registerIpc, maybeStart, start, stop, isEnabled, PROVIDER_ID };
