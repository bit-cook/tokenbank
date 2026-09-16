// host.js — ChatGPT 网页源内嵌浏览器宿主（多实例）。
// 每个实例 = 一个 ChatGPT 账户 = 独立 BrowserWindow + 独立 persist 分区，
// 经 webContents.executeJavaScript 注入 injected-driver.js 驱动各自的网页会话。
// 边界：只驱动用户自己已登录的会话；不代填凭据；不做反爬。
const path = require('path');
const fs = require('fs');
let ChatGptMarkdownBuffer = null;
try { ({ ChatGptMarkdownBuffer } = require('./markdown')); }
catch (e) { console.warn('[chatgpt-web:host] markdown buffer 不可用，回退纯文本收流:', e && e.message); }

const CHATGPT_URL = 'https://chatgpt.com/?temporary-chat=true';
const DRIVER_SRC = fs.readFileSync(path.join(__dirname, 'injected-driver.js'), 'utf8');
const CHAT_RESET_TURNS = 6;

let BrowserWindow = null; // 延迟 require
const insts = new Map(); // instanceId -> { win, queue }

function log(...a) { console.log('[chatgpt-web:host]', ...a); }
function ensureElectron() { if (!BrowserWindow) ({ BrowserWindow } = require('electron')); }
function inst(id) { let e = insts.get(id); if (!e) { e = { win: null, queue: Promise.resolve() }; insts.set(id, e); } return e; }

function ensureWindow(id) {
  ensureElectron();
  const e = inst(id);
  if (e.win && !e.win.isDestroyed()) return e.win;
  const win = new BrowserWindow({
    width: 960, height: 720, show: false,
    title: `ChatGPT 网页（${id} · 登录）`,
    webPreferences: { partition: `persist:tb-chatgpt-web-${id}` }, // 每实例独立登录态
  });
  win.on('close', (ev) => { if (!win.__tbForceClose) { ev.preventDefault(); win.hide(); } });
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(DRIVER_SRC).catch((err) => log('注入失败', err.message));
  });
  e.win = win;
  return win;
}

function beginLoad(id) {
  const w = ensureWindow(id);
  if (!w.__tbLoadStarted) {
    w.__tbLoadStarted = true;
    w.loadURL(CHATGPT_URL).catch((e) => { if (!/ERR_ABORTED/.test(String(e && e.message))) log('loadURL', e && e.message); });
  }
  return w;
}

function waitReady(w, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const wc = w.webContents;
    if (wc.getURL() && !wc.isLoadingMainFrame()) { resolve(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(to); wc.off('dom-ready', finish); wc.off('did-stop-loading', finish); resolve(); };
    const to = setTimeout(finish, timeoutMs);
    wc.once('dom-ready', finish); wc.once('did-stop-loading', finish);
  });
}

async function evalDriver(w, expr) {
  await w.webContents.executeJavaScript(DRIVER_SRC).catch(() => {});
  return w.webContents.executeJavaScript(expr, true);
}

async function isLoggedIn(id) {
  try { const w = beginLoad(id); await waitReady(w); return await evalDriver(w, 'window.__tbCgw.isLoggedIn()'); }
  catch (e) { log('isLoggedIn 失败', e.message); return false; }
}

async function showLogin(id) { const w = beginLoad(id); w.show(); w.focus(); return { ok: true }; }
function hideLogin(id) { const e = insts.get(id); if (e && e.win && !e.win.isDestroyed()) e.win.hide(); }

// 重置到全新临时对话
async function freshChat(w) {
  try {
    w.__tbLoadStarted = true;
    const p = w.webContents.loadURL(CHATGPT_URL);
    if (p && p.catch) p.catch(() => {});
    await waitReady(w);
    for (let i = 0; i < 12; i += 1) {
      try { if (await evalDriver(w, 'window.__tbCgw.isLoggedIn()')) return true; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) { log('freshChat', e && e.message); }
  return false;
}

// 跑一轮（按实例串行）
async function runTurn(id, prompt, { onDelta, signal, overallTimeoutMs = 180000 } = {}) {
  const e = inst(id);
  const task = e.queue.then(() => doRunTurn(id, prompt, { onDelta, signal, overallTimeoutMs }));
  e.queue = task.then(() => {}, () => {});
  return task;
}

async function doRunTurn(id, prompt, { onDelta, signal, overallTimeoutMs }) {
  const w = beginLoad(id);
  await waitReady(w);
  let loggedIn = false;
  for (let i = 0; i < 12; i += 1) {
    try { loggedIn = await evalDriver(w, 'window.__tbCgw.isLoggedIn()'); } catch { loggedIn = false; }
    if (loggedIn) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!loggedIn) { const e = new Error('尚未登录 ChatGPT，请在该卡片点“登录 ChatGPT”完成登录'); e.code = 'NOT_LOGGED_IN'; throw e; }

  let acc = 0;
  try { acc = await evalDriver(w, 'window.__tbCgw.assistantTurnCount()'); } catch { acc = 0; }
  if (acc > CHAT_RESET_TURNS) { log(`[${id}] 回合累积`, acc, '→ 重置新会话'); await freshChat(w); }

  const sub = await evalDriver(w, `window.__tbCgw.submit(${JSON.stringify(prompt)})`);
  log(`[${id}] 已提交 via=`, sub && sub.via);
  const beforeCount = (sub && sub.beforeCount) || 0;
  try { await evalDriver(w, `window.__tbCgw.bindNewTurn(${beforeCount})`); }
  catch (e) { try { log(`[${id}] bind 失败探针`, JSON.stringify(await evalDriver(w, 'window.__tbCgw.probe()'))); } catch {} throw e; }

  const deadline = Date.now() + overallTimeoutMs;
  const buffer = ChatGptMarkdownBuffer ? new ChatGptMarkdownBuffer() : null;
  const safeEnd = (s, end) => { if (end > 0 && end < s.length) { const c = s.charCodeAt(end - 1); if (c >= 0xD800 && c <= 0xDBFF) return end - 1; } return end; };
  const SETTLE_MS = 2000;
  let candSig = null; let candSince = 0; let fullText = '';
  while (Date.now() < deadline) {
    if (signal?.aborted) { const e = new Error('已取消'); e.code = 'ABORTED'; throw e; }
    const snap = await evalDriver(w, 'window.__tbCgw.snapshot()');
    const segments = (snap && Array.isArray(snap.markdownSegments)) ? snap.markdownSegments : [];
    const visibleText = snap && typeof snap.visibleText === 'string' ? snap.visibleText : '';
    const hasCopy = !!(snap && snap.hasCopy);
    const stop = !!(snap && snap.stop);
    if (buffer) {
      try { const delta = buffer.observe(segments); if (delta) { fullText += delta; if (onDelta) onDelta(delta); } }
      catch (e) { log('observe 异常', e && e.message); }
    } else if (visibleText.startsWith(fullText) && visibleText.length > fullText.length) {
      const end = safeEnd(visibleText, visibleText.length);
      if (end > fullText.length) { const d = visibleText.slice(fullText.length, end); fullText = visibleText.slice(0, end); if (onDelta && d) onDelta(d); }
    }
    const complete = !stop && hasCopy && visibleText.length > 0;
    if (complete) {
      if (candSig !== visibleText) { candSig = visibleText; candSince = Date.now(); }
      else if (Date.now() - candSince >= SETTLE_MS) {
        let finalText = fullText;
        if (buffer) {
          try { const fin = buffer.finish(); if (fin.delta && onDelta) onDelta(fin.delta); finalText = fin.markdown || fullText; }
          catch (e) {
            if (visibleText.startsWith(fullText) && visibleText.length > fullText.length && onDelta) onDelta(visibleText.slice(fullText.length));
            finalText = visibleText || fullText;
          }
        } else {
          if (visibleText.startsWith(fullText) && visibleText.length > fullText.length && onDelta) onDelta(visibleText.slice(fullText.length));
          finalText = visibleText || fullText;
        }
        log(`[${id}] 完成，长度`, finalText.length, buffer ? '(md)' : '(text)');
        return { text: finalText };
      }
    } else { candSig = null; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (buffer) { try { const fin = buffer.finish(); if (fin.markdown) fullText = fin.markdown; } catch { /* ignore */ } }
  if (fullText) return { text: fullText };
  const e = new Error('等待 ChatGPT 回复超时'); e.code = 'TIMEOUT'; throw e;
}

function destroy(id) {
  const e = insts.get(id);
  if (e && e.win && !e.win.isDestroyed()) { e.win.__tbForceClose = true; e.win.destroy(); }
  insts.delete(id);
}
function destroyAll() { for (const k of [...insts.keys()]) destroy(k); }

module.exports = { isLoggedIn, showLogin, hideLogin, runTurn, destroy, destroyAll, CHATGPT_URL };
