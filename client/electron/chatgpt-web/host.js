// host.js — ChatGPT 网页源的内嵌浏览器宿主（Electron 原生，取代 miuuyy 的 playwright+外接浏览器）。
// 持久分区 BrowserWindow 加载 chatgpt.com；用户在里面登录自己的账号；
// 经 webContents.executeJavaScript 注入 injected-driver.js 驱动 composer 收发。
// 边界：只驱动用户自己已登录的会话；不代填凭据；不做反爬。
const path = require('path');
const fs = require('fs');

const CHATGPT_URL = 'https://chatgpt.com/?temporary-chat=true';
const PARTITION = 'persist:tb-chatgpt-web';
const DRIVER_SRC = fs.readFileSync(path.join(__dirname, 'injected-driver.js'), 'utf8');

let BrowserWindow = null; // 延迟 require，避免非 Electron 环境（测试）报错
let win = null;
let queue = Promise.resolve(); // 串行：一个网页会话同时只跑一轮

function log(...a) { console.log('[chatgpt-web:host]', ...a); }

function ensureElectron() {
  if (!BrowserWindow) ({ BrowserWindow } = require('electron'));
}

function ensureWindow() {
  ensureElectron();
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 960,
    height: 720,
    show: false, // 默认后台；需要登录时才 show
    title: 'ChatGPT 网页源（登录）',
    webPreferences: {
      partition: PARTITION, // cookie/登录态持久化
      // 不挂 preload、不开 nodeIntegration：这就是个真浏览器视图
    },
  });
  win.on('close', (e) => {
    // 关掉只是隐藏，别销毁登录态
    if (!win.__tbForceClose) { e.preventDefault(); win.hide(); }
  });
  // 每次导航完成后重新注入驱动
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(DRIVER_SRC).catch((err) => log('注入失败', err.message));
  });
  return win;
}

// 只加载一次；loadURL 的 promise 在页面重定向时会 reject(ERR_ABORTED)，属正常，吞掉。
function beginLoad() {
  const w = ensureWindow();
  if (!w.__tbLoadStarted) {
    w.__tbLoadStarted = true;
    w.loadURL(CHATGPT_URL).catch((e) => {
      // ChatGPT 未登录会重定向到 auth 页 → 原导航被中断，非致命
      if (!/ERR_ABORTED/.test(String(e && e.message))) log('loadURL', e && e.message);
    });
  }
  return w;
}

// 等页面这一轮导航停下来（dom-ready 或 did-stop-loading），不强制重新 load
function waitReady(w, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const wc = w.webContents;
    if (wc.getURL() && !wc.isLoadingMainFrame()) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(to); wc.off('dom-ready', finish); wc.off('did-stop-loading', finish);
      resolve();
    };
    const to = setTimeout(finish, timeoutMs);
    wc.once('dom-ready', finish);
    wc.once('did-stop-loading', finish);
  });
}

async function evalDriver(expr) {
  const w = ensureWindow();
  // 保证驱动在位（页面可能重定向/被用户手动导航过）
  await w.webContents.executeJavaScript(DRIVER_SRC).catch(() => {});
  return w.webContents.executeJavaScript(expr, true);
}

async function isLoggedIn() {
  try {
    const w = beginLoad();
    await waitReady(w);
    return await evalDriver('window.__tbCgw.isLoggedIn()');
  } catch (e) { log('isLoggedIn 失败', e.message); return false; }
}

// 弹出内嵌视图让用户自己登录（tokenbank 不代填账号密码）。不 await 加载，避免重定向 abort 抛错。
async function showLogin() {
  const w = beginLoad();
  w.show();
  w.focus();
  return { ok: true };
}

function hideLogin() {
  if (win && !win.isDestroyed()) win.hide();
}

// 独立授权窗口（同一 persist 分区，共享 ChatGPT 登录态）——给 Codex OAuth 授权页用，
// 不动驱动 DOM 的主窗口。
let authWin = null;
async function openAuthUrl(url) {
  ensureElectron();
  if (!authWin || authWin.isDestroyed()) {
    authWin = new BrowserWindow({
      width: 520, height: 700, title: 'ChatGPT 授权',
      webPreferences: { partition: PARTITION },
    });
    authWin.on('closed', () => { authWin = null; });
  }
  authWin.loadURL(url).catch((e) => {
    if (!/ERR_ABORTED/.test(String(e && e.message))) log('openAuthUrl', e && e.message);
  });
  authWin.show();
  authWin.focus();
  return { ok: true };
}
function closeAuth() {
  if (authWin && !authWin.isDestroyed()) authWin.close();
  authWin = null;
}

// 重置到全新临时对话：重载 temp-chat URL → 回合清零，消除累积/虚拟化导致的读空超时。
async function freshChat(w) {
  try {
    w.__tbLoadStarted = true;
    const p = w.webContents.loadURL(CHATGPT_URL);
    if (p && p.catch) p.catch(() => {}); // 未登录会重定向 → ERR_ABORTED，无害
    await waitReady(w);
    // 等 SPA 把 composer 渲染出来（已登录时）
    for (let i = 0; i < 12; i += 1) {
      try { if (await evalDriver('window.__tbCgw.isLoggedIn()')) return true; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) { log('freshChat', e && e.message); }
  return false;
}

// 跑一轮：submit → 绑定新 turn → 轮询收流；onDelta(增量文本)
async function runTurn(prompt, { onDelta, signal, overallTimeoutMs = 180000 } = {}) {
  const task = queue.then(() => doRunTurn(prompt, { onDelta, signal, overallTimeoutMs }));
  // 串行：即使本轮抛错也不卡死队列
  queue = task.then(() => {}, () => {});
  return task;
}

async function doRunTurn(prompt, { onDelta, signal, overallTimeoutMs }) {
  const w = ensureWindow();
  // 每轮都重置到全新临时对话（回合数恒为 0，避免累积/漂移）
  const loggedIn = await freshChat(w);
  log('runTurn: 新会话就绪，登录=', loggedIn);
  if (!loggedIn) {
    log('runTurn: 判定未登录');
    const e = new Error('尚未登录 ChatGPT，请在「ChatGPT 源」卡片点“登录 ChatGPT”完成登录'); e.code = 'NOT_LOGGED_IN'; throw e;
  }
  const sub = await evalDriver(`window.__tbCgw.submit(${JSON.stringify(prompt)})`);
  log('runTurn: 已提交 via=', sub && sub.via, ' 提交前回合数=', sub && sub.beforeCount);
  const beforeCount = (sub && sub.beforeCount) || 0;
  // 提交后 1.5s dump 一次 DOM 探针，用于诊断选择器
  await new Promise((r) => setTimeout(r, 1500));
  try { log('runTurn: 提交后探针', JSON.stringify(await evalDriver('window.__tbCgw.probe()'))); } catch (e) { log('探针失败', e.message); }
  let turnIndex;
  try {
    turnIndex = await evalDriver(`window.__tbCgw.bindNewTurn(${beforeCount})`);
    log('runTurn: 绑定新回合索引', turnIndex);
  } catch (e) {
    try { log('runTurn: bind 失败时探针', JSON.stringify(await evalDriver('window.__tbCgw.probe()'))); } catch {}
    throw e;
  }

  const deadline = Date.now() + overallTimeoutMs;
  let last = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) { const e = new Error('已取消'); e.code = 'ABORTED'; throw e; }
    const { text, done } = await evalDriver('window.__tbCgw.poll()');
    if (text && text.length > last.length) {
      const delta = text.slice(last.length);
      last = text;
      if (onDelta) onDelta(delta);
      stableSince = 0;
    } else if (text === last && text.length > 0) {
      stableSince = stableSince || Date.now();
    }
    if (done) { log('runTurn: 完成，长度', (last || text).length); return { text: last || text }; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (last) { log('runTurn: 超时但有部分文本，长度', last.length); return { text: last }; }
  const e = new Error('等待 ChatGPT 回复超时'); e.code = 'TIMEOUT'; throw e;
}

function destroy() {
  if (win && !win.isDestroyed()) { win.__tbForceClose = true; win.destroy(); }
  win = null;
}

module.exports = { isLoggedIn, showLogin, hideLogin, openAuthUrl, closeAuth, runTurn, destroy, CHATGPT_URL };
