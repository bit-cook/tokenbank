// index.js — ChatGPT 网页源编排层（多实例）。
// 每个实例 = 一个账户 = provider `chatgpt-web-<n>` + 独立 server(端口) + 独立浏览器分区。
// main.js 只需 require 本模块调 registerIpc / maybeStart。
const server = require('./server');
const host = require('./host');

const INSTANCE_RE = /^chatgpt-web-(\d+)$/;

let deps = { readAgentConfig: null, writeAgentConfig: null };
function log(...a) { console.log('[chatgpt-web]', ...a); }

function readCfg() { try { return deps.readAgentConfig?.() || {}; } catch { return {}; } }
function writeCfg(cfg) { try { deps.writeAgentConfig?.(cfg); } catch (e) { log('写配置失败', e && e.message); } }

// 所有实例 provider（chatgpt-web-<n>）
function instanceProviders() {
  return (readCfg().providers || []).filter((p) => p && INSTANCE_RE.test(p.id));
}
function nextIndex() {
  let max = 0;
  for (const p of instanceProviders()) { const m = INSTANCE_RE.exec(p.id); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

// 写/补正某实例的 provider 条目（base_url/token 由 server 分配）
function upsertProvider(providerId, n, { port, token }, { enable } = {}) {
  const cfg = readCfg();
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const base = `http://127.0.0.1:${port}`;
  const models = server.WEB_MODELS.map((m) => ({ name: m, type: 'chat' }));
  const patch = {
    id: providerId,
    label: `ChatGPT 网页 ${n}`,
    type: 'free',            // 可路由 tier，且非 paid → 不被 migrateAgentProviders 清理
    handler: 'openai',
    api_format: 'responses',
    supports_responses: true,
    base_url: base,
    token,
    local_only: true,
    experimental: true,
    chatgpt_web_instance: n, // 标记 + 序号（前端显示/排序）
  };
  const i = providers.findIndex((x) => x && x.id === providerId);
  if (i >= 0) {
    const prevEnabled = providers[i].enabled;
    const prevModels = Array.isArray(providers[i].models) && providers[i].models.length ? providers[i].models : models;
    providers[i] = { ...providers[i], ...patch, models: prevModels, enabled: enable === undefined ? prevEnabled : !!enable };
  } else {
    providers.push({ ...patch, models, enabled: !!enable });
  }
  cfg.providers = providers;
  writeCfg(cfg);
}

// 新增一个实例：分配序号 → 起 server → 写 provider（启用）
async function addInstance() {
  const n = nextIndex();
  const providerId = `chatgpt-web-${n}`;
  const st = await server.start(providerId);
  upsertProvider(providerId, n, st, { enable: true });
  log('新增实例', providerId, 'port', st.port);
  return { id: providerId, n, ...st };
}

// 移除某实例：停 server + 销毁窗口 + 从 conf/agent 删除
function removeInstance(providerId) {
  server.forget(providerId);
  host.destroy(providerId);
  const cfg = readCfg();
  if (Array.isArray(cfg.providers)) {
    const before = cfg.providers.length;
    cfg.providers = cfg.providers.filter((p) => !(p && p.id === providerId));
    if (cfg.providers.length !== before) writeCfg(cfg);
  }
  log('移除实例', providerId);
}

// 确保某实例 server 起着并补正 base_url/token（登录/测试前调）
async function ensureInstance(providerId) {
  const p = instanceProviders().find((x) => x.id === providerId);
  const n = p ? (p.chatgpt_web_instance || Number(INSTANCE_RE.exec(providerId)?.[1]) || 1) : (Number(INSTANCE_RE.exec(providerId)?.[1]) || 1);
  const st = await server.start(providerId);
  upsertProvider(providerId, n, st, {}); // 保留 enabled
  return st;
}

// 迁移：删掉旧的单实例 chatgpt-web 条目（现改用 chatgpt-web-<n>）
function migrateLegacy() {
  const cfg = readCfg();
  if (Array.isArray(cfg.providers) && cfg.providers.some((p) => p && p.id === 'chatgpt-web')) {
    cfg.providers = cfg.providers.filter((p) => !(p && p.id === 'chatgpt-web'));
    writeCfg(cfg);
    log('迁移：移除旧单实例 chatgpt-web 条目');
  }
}

// 开机：为每个「启用」的实例起 server + 补正
async function maybeStart() {
  migrateLegacy();
  const enabled = instanceProviders().filter((p) => p.enabled !== false);
  if (!enabled.length) { log('无启用实例，跳过自启'); return; }
  for (const p of enabled) {
    try { await ensureInstance(p.id); } catch (e) { log('实例自启失败', p.id, e && e.message); }
  }
  log('已就绪，启用实例数', enabled.length);
}

async function statusOf(providerId) {
  const st = server.statusOf(providerId);
  let loggedIn = false;
  if (st.running) { try { loggedIn = await host.isLoggedIn(providerId); } catch {} }
  return { ...st, loggedIn };
}

function registerIpc(ipcMain, injected) {
  deps = { ...deps, ...injected };
  const argId = (a) => (typeof a === 'string' ? a : (a && a.id) || '');

  ipcMain.handle('chatgptweb:add', async () => addInstance());
  ipcMain.handle('chatgptweb:remove', async (_e, a) => { removeInstance(argId(a)); return { ok: true }; });
  ipcMain.handle('chatgptweb:list', async () => {
    const out = [];
    for (const p of instanceProviders()) out.push({ id: p.id, n: p.chatgpt_web_instance, enabled: p.enabled !== false, ...(await statusOf(p.id)) });
    return out;
  });
  ipcMain.handle('chatgptweb:status', async (_e, a) => statusOf(argId(a)));
  ipcMain.handle('chatgptweb:login', async (_e, a) => { const id = argId(a); await ensureInstance(id); await host.showLogin(id); return { ok: true }; });
  ipcMain.handle('chatgptweb:hideLogin', async (_e, a) => { host.hideLogin(argId(a)); return { ok: true }; });
  ipcMain.handle('chatgptweb:test', async (_e, a) => {
    const id = argId(a);
    try { await ensureInstance(id); const out = await host.runTurn(id, '用一句话回复：ok', { overallTimeoutMs: 60000 }); return { ok: true, text: out.text }; }
    catch (e) { return { ok: false, code: e.code || 'error', message: e.message }; }
  });
  ipcMain.handle('chatgptweb:conn', async (_e, a) => {
    const st = server.statusOf(argId(a));
    return { port: st.port, endpoint: st.port ? `http://127.0.0.1:${st.port}` : null, tokenMasked: st.token ? st.token.slice(0, 8) + '…' : null };
  });
}

module.exports = { registerIpc, maybeStart, addInstance, removeInstance, instanceProviders };
