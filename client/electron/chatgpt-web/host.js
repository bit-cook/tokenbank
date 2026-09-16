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

const CHAT_RESET_TURNS = 6; // 累积超过这么多回合才重置新会话（否则每轮不重载，省延迟）

async function doRunTurn(prompt, { onDelta, signal, overallTimeoutMs }) {
  const w = beginLoad();
  await waitReady(w);
  // 登录检查：页面刚加载 composer 可能没渲染，给 SPA 几秒重试
  let loggedIn = false;
  for (let i = 0; i < 12; i += 1) {
    try { loggedIn = await evalDriver('window.__tbCgw.isLoggedIn()'); } catch { loggedIn = false; }
    if (loggedIn) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!loggedIn) {
    log('runTurn: 判定未登录');
    const e = new Error('尚未登录 ChatGPT，请在「ChatGPT 源」卡片点“登录 ChatGPT”完成登录'); e.code = 'NOT_LOGGED_IN'; throw e;
  }
  // 回合累积过多才重置（poll 读末回合已消除漂移，这里只为防上下文膨胀）
  let acc = 0;
  try { acc = await evalDriver('window.__tbCgw.assistantTurnCount()'); } catch { acc = 0; }
  if (acc > CHAT_RESET_TURNS) { log('runTurn: 回合累积', acc, '→ 重置新会话'); await freshChat(w); }

  const sub = await evalDriver(`window.__tbCgw.submit(${JSON.stringify(prompt)})`);
  log('runTurn: 已提交 via=', sub && sub.via, ' 提交前回合数=', sub && sub.beforeCount);
  const beforeCount = (sub && sub.beforeCount) || 0;
  let turnIndex;
  try {
    turnIndex = await evalDriver(`window.__tbCgw.bindNewTurn(${beforeCount})`);
    log('runTurn: 绑定新回合索引', turnIndex);
  } catch (e) {
    try { log('runTurn: bind 失败时探针', JSON.stringify(await evalDriver('window.__tbCgw.probe()'))); } catch {}
    throw e;
  }

  const deadline = Date.now() + overallTimeoutMs;
  let emitted = ''; // 已吐出的部分（保证是 cur 的前缀）
  // 安全切点：不落在代理项对(高代理)中间，避免半个 emoji → �
  const safeEnd = (s, end) => {
    if (end > 0 && end < s.length) {
      const c = s.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) return end - 1; // 末尾是高代理项，留到下一轮
    }
    return end;
  };
  // 完成判定（port 自 miuuyy chatGptTurnIsComplete + 稳定窗口）：
  //   非生成中(无 stop) 且 有复制按钮 且 有文本 —— 该状态的文本连续稳定 SETTLE_MS 才算真完成。
  const SETTLE_MS = 2000;
  let candSig = null; let candSince = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) { const e = new Error('已取消'); e.code = 'ABORTED'; throw e; }
    const poll = await evalDriver('window.__tbCgw.poll()');
    const cur = poll && typeof poll.text === 'string' ? poll.text : '';
    const hasCopy = !!(poll && poll.hasCopy);
    const stop = !!(poll && poll.stop);
    // 仅当新文本是已吐出内容的「前缀延伸」才吐增量（重排/回退时不吐错乱片段，等收尾兜底）
    if (cur && cur.startsWith(emitted) && cur.length > emitted.length) {
      const end = safeEnd(cur, cur.length);
      if (end > emitted.length) {
        const delta = cur.slice(emitted.length, end);
        emitted = cur.slice(0, end);
        if (onDelta && delta) onDelta(delta);
      }
    }
    // 必须：无 stop + 有复制按钮 + 有文本，且该文本稳定 SETTLE_MS
    const complete = !stop && hasCopy && cur.length > 0;
    if (complete) {
      if (candSig !== cur) { candSig = cur; candSince = Date.now(); }
      else if (Date.now() - candSince >= SETTLE_MS) {
        if (onDelta && cur.startsWith(emitted) && cur.length > emitted.length) onDelta(cur.slice(emitted.length));
        log('runTurn: 完成，长度', cur.length);
        return { text: cur };
      }
    } else {
      candSig = null;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (emitted) { log('runTurn: 超时但有部分文本，长度', emitted.length); return { text: emitted }; }
  const e = new Error('等待 ChatGPT 回复超时'); e.code = 'TIMEOUT'; throw e;
}

function destroy() {
  if (win && !win.isDestroyed()) { win.__tbForceClose = true; win.destroy(); }
  win = null;
}

module.exports = { isLoggedIn, showLogin, hideLogin, runTurn, destroy, CHATGPT_URL };
