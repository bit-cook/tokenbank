// host.js — ChatGPT 网页源内嵌浏览器宿主（多实例）。
// 每个实例 = 一个 ChatGPT 账户 = 独立 BrowserWindow + 独立 persist 分区，
// 经 webContents.executeJavaScript 注入 injected-driver.js 驱动各自的网页会话。
// 边界：只驱动用户自己已登录的会话；不代填凭据；不做反爬。
const path = require('path');
const fs = require('fs');
const os = require('os');
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
  // persist 分区需显式套系统/环境代理，否则直连 chatgpt.com 会 SSL -201
  try {
    const { applySessionProxy } = require('../chromium-session-proxy');
    win.__tbProxyReady = applySessionProxy(win.webContents.session, `chatgpt-web:${id}`);
  } catch (err) {
    win.__tbProxyReady = Promise.resolve();
    log('setProxy 跳过', err && err.message);
  }
  win.on('close', (ev) => { if (!win.__tbForceClose) { ev.preventDefault(); win.hide(); } });
  win.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    if (code) log('did-fail-load', code, desc, url);
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(DRIVER_SRC).catch((err) => log('注入失败', err.message));
  });
  e.win = win;
  return win;
}

async function beginLoad(id) {
  const w = ensureWindow(id);
  try { if (w.__tbProxyReady) await w.__tbProxyReady; } catch (err) { log('setProxy', err && err.message); }
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function detectImageMime(buf, fallback = 'image/png') {
  if (!buf || buf.length < 12) return fallback;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return fallback;
}

function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

async function urlToBuffer(url) {
  const data = parseDataUrl(url);
  if (data) return data;
  if (/^file:\/\//i.test(url)) {
    const p = decodeURIComponent(String(url).replace(/^file:\/\//i, ''));
    const buf = fs.readFileSync(p);
    return { mime: detectImageMime(buf), buf };
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const ct = String(resp.headers.get('content-type') || '').split(';')[0].trim();
  return { mime: detectImageMime(buf, ct.startsWith('image/') ? ct : 'image/png'), buf };
}

// 把请求里的 data URL / http(s) / file:// 落成临时文件，供 CDP setFileInputFiles
async function materializeImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { dir: '', files: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cgw-img-'));
  const files = [];
  let total = 0;
  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const url = typeof item === 'string' ? item : (item && item.url);
      if (!url) continue;
      const { mime, buf } = await urlToBuffer(url);
      if (!buf || !buf.length) throw new Error(`第 ${i + 1} 张图为空`);
      if (buf.length > 20_000_000) throw new Error(`第 ${i + 1} 张图超过 20 MB`);
      total += buf.length;
      if (total > 50_000_000) throw new Error('附图合计超过 50 MB');
      const kind = detectImageMime(buf, mime);
      const ext = IMAGE_EXT[String(kind).toLowerCase()];
      if (!ext) throw new Error(`不支持的图片类型: ${kind}`);
      const name = `input-image-${i + 1}.${ext}`;
      const abs = path.join(dir, name);
      fs.writeFileSync(abs, buf);
      files.push({ name, path: abs, mime: kind });
    }
  } catch (e) {
    cleanupDir(dir);
    throw e;
  }
  return { dir, files };
}

function cleanupDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// CDP 原生塞文件：合成 File/DataTransfer 过不了 ChatGPT 的 React onChange
async function setInputFiles(wc, selector, filePaths) {
  const dbg = wc.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) {
    await dbg.attach('1.3');
    attachedHere = true;
  }
  try {
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const rootId = doc.root && doc.root.nodeId;
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: rootId, selector });
    if (!nodeId) throw new Error(`未找到文件输入 ${selector}`);
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: filePaths });
  } finally {
    if (attachedHere) {
      try { dbg.detach(); } catch { /* ignore */ }
    }
  }
}

async function waitFileInput(w, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sel = await evalDriver(w, 'window.__tbCgw.fileInputSelector()');
    if (sel) return sel;
    await sleep(200);
  }
  throw new Error('ChatGPT 页面没有附件输入框（当前账号可能不支持传图）');
}

async function waitAttachments(w, names, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evalDriver(w, `window.__tbCgw.attachmentsStatus(${JSON.stringify(names)})`);
    if (last && last.alerts && last.alerts.length) {
      throw new Error('ChatGPT 未接受全部附图: ' + last.alerts.join(' | '));
    }
    if (last && last.ready && last.sendEnabled) return last;
    await sleep(200);
  }
  const miss = last && last.missing && last.missing.length ? last.missing.join(', ') : names.join(', ');
  throw new Error('等待附图就绪超时: ' + miss);
}

async function isLoggedIn(id) {
  try { const w = await beginLoad(id); await waitReady(w); return await evalDriver(w, 'window.__tbCgw.isLoggedIn()'); }
  catch (e) { log('isLoggedIn 失败', e.message); return false; }
}

async function showLogin(id) { const w = await beginLoad(id); w.show(); w.focus(); return { ok: true }; }
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
async function runTurn(id, prompt, { onDelta, signal, overallTimeoutMs = 180000, images } = {}) {
  const e = inst(id);
  const task = e.queue.then(() => doRunTurn(id, prompt, { onDelta, signal, overallTimeoutMs, images }));
  e.queue = task.then(() => {}, () => {});
  return task;
}

async function doRunTurn(id, prompt, { onDelta, signal, overallTimeoutMs, images }) {
  const w = await beginLoad(id);
  await waitReady(w);
  let loggedIn = false;
  for (let i = 0; i < 12; i += 1) {
    try { loggedIn = await evalDriver(w, 'window.__tbCgw.isLoggedIn()'); } catch { loggedIn = false; }
    if (loggedIn) break;
    await sleep(500);
  }
  if (!loggedIn) { const e = new Error('尚未登录 ChatGPT，请在该卡片点“登录 ChatGPT”完成登录'); e.code = 'NOT_LOGGED_IN'; throw e; }

  let acc = 0;
  try { acc = await evalDriver(w, 'window.__tbCgw.assistantTurnCount()'); } catch { acc = 0; }
  if (acc > CHAT_RESET_TURNS) { log(`[${id}] 回合累积`, acc, '→ 重置新会话'); await freshChat(w); }

  let staged = { dir: '', files: [] };
  let sub;
  try {
    staged = await materializeImages(images);
    if (staged.files.length) {
      // 先填字再挂文件：fill 会清空 composer，反过来会把已挂的图清掉
      await evalDriver(w, `window.__tbCgw.fill(${JSON.stringify(prompt)})`);
      const sel = await waitFileInput(w);
      log(`[${id}] 附图`, staged.files.length, 'via', sel);
      await setInputFiles(w.webContents, sel, staged.files.map((f) => f.path));
      await waitAttachments(w, staged.files.map((f) => f.name));
      const beforeCount = await evalDriver(w, 'window.__tbCgw.assistantTurnCount()');
      sub = await evalDriver(w, `window.__tbCgw.send(${Number(beforeCount) || 0})`);
    } else {
      sub = await evalDriver(w, `window.__tbCgw.submit(${JSON.stringify(prompt)})`);
    }
  } finally {
    cleanupDir(staged.dir);
  }
  log(`[${id}] 已提交 via=`, sub && sub.via, staged.files.length ? `images=${staged.files.length}` : '');
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

module.exports = { isLoggedIn, showLogin, hideLogin, runTurn, destroy, destroyAll, CHATGPT_URL, materializeImages };
