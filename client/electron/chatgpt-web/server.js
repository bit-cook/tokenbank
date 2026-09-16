// server.js — ChatGPT 网页源本地 Responses 端点（多实例）。
// 每个实例 = 一个 ChatGPT 账户 = 独立 http server(端口) + 独立 Bearer + 独立浏览器分区。
// 每个 server 绑定 instanceId，请求转 host.runTurn(id, ...) 驱动该账户的网页会话。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const host = require('./host');
let transform = null;
try { transform = require('../codex-transform'); } catch { /* 测试环境可缺省 */ }

const CONF_PATH = path.join(os.homedir(), '.tokenbank', 'chatgpt-web.json');
const DEFAULT_PORT = 17841;
const WEB_MODELS = ['chatgpt-web', 'chatgpt-web-thinking'];

const servers = new Map(); // instanceId -> { server, port, token }

function log(...a) { console.log('[chatgpt-web:server]', ...a); }

function loadConf() {
  try { const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')); return c && typeof c === 'object' ? c : {}; }
  catch { return {}; }
}
function saveConf(c) {
  try { fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true }); fs.writeFileSync(CONF_PATH, JSON.stringify(c, null, 2), 'utf8'); }
  catch (e) { log('写配置失败', e.message); }
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(16).toString('hex')}`; }

// ---- 请求解析：Responses `input` 或 Chat `messages` → 单条 prompt ----
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return content?.text || '';
}
function flattenToPrompt(body) {
  const parts = [];
  let src = body;
  if (transform && Array.isArray(body.input)) { try { src = transform.responsesToChat(body) || body; } catch { src = body; } }
  if (src.instructions) parts.push(String(src.instructions).trim());
  else if (body.instructions) parts.push(String(body.instructions).trim());
  const items = Array.isArray(src.messages) ? src.messages
    : Array.isArray(body.input) ? body.input
    : Array.isArray(body.messages) ? body.messages : null;
  if (items) {
    for (const m of items) {
      const role = m.role || 'user';
      const text = textOfContent(m.content).trim();
      if (!text) continue;
      if (role === 'system') parts.push(text);
      else if (role === 'assistant') parts.push(`（助手先前回复）${text}`);
      else parts.push(text);
    }
  } else if (typeof body.input === 'string') { parts.push(body.input); }
  return parts.filter(Boolean).join('\n\n');
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function baseResponse(respId, model, status, output) {
  return { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output: output || [], usage: null, metadata: {} };
}
function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleResponses(instId, res, body, wantStream) {
  const model = body.model || 'chatgpt-web';
  const prompt = flattenToPrompt(body);
  if (!prompt) { sendJson(res, 400, { error: { message: 'empty input' } }); return; }
  const respId = id('resp'); const itemId = id('msg');
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, 'response.created', { type: 'response.created', response: baseResponse(respId, model, 'in_progress', []) });
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item });
    sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    let full = '';
    try {
      const out = await host.runTurn(instId, prompt, { onDelta: (delta) => { full += delta; sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta }); } });
      full = out.text || full;
    } catch (e) {
      sse(res, 'response.failed', { type: 'response.failed', response: { ...baseResponse(respId, model, 'failed', []), error: { code: e.code || 'error', message: e.message } } });
      res.end(); return;
    }
    sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: full });
    const doneItem = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] };
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: doneItem });
    sse(res, 'response.completed', { type: 'response.completed', response: baseResponse(respId, model, 'completed', [doneItem]) });
    res.end();
    return;
  }
  try {
    const out = await host.runTurn(instId, prompt, {});
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: out.text || '', annotations: [] }] };
    sendJson(res, 200, baseResponse(respId, model, 'completed', [item]));
  } catch (e) { sendJson(res, e.code === 'NOT_LOGGED_IN' ? 401 : 502, { error: { code: e.code || 'error', message: e.message } }); }
}

async function handleChat(instId, res, body, wantStream) {
  const model = body.model || 'chatgpt-web';
  const prompt = flattenToPrompt(body);
  if (!prompt) { sendJson(res, 400, { error: { message: 'empty messages' } }); return; }
  const cid = id('chatcmpl');
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`);
    try { chunk({ role: 'assistant' }); await host.runTurn(instId, prompt, { onDelta: (d) => chunk({ content: d }) }); chunk({}, 'stop'); }
    catch (e) { chunk({ content: `\n[错误] ${e.message}` }, 'stop'); }
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }
  try {
    const out = await host.runTurn(instId, prompt, {});
    sendJson(res, 200, { id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: out.text || '' }, finish_reason: 'stop' }] });
  } catch (e) { sendJson(res, e.code === 'NOT_LOGGED_IN' ? 401 : 502, { error: { code: e.code || 'error', message: e.message } }); }
}

function bearerOk(req, token) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !token) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeOnRequest(instId) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/health' || p === '') { sendJson(res, 200, { ok: true, running: true, instance: instId }); return; }
    const s = servers.get(instId);
    if (!bearerOk(req, s && s.token)) { sendJson(res, 401, { error: { message: 'invalid bearer' } }); return; }
    if (p === '/v1/models' || p === '/models') { sendJson(res, 200, { object: 'list', data: WEB_MODELS.map((m) => ({ id: m, object: 'model', owned_by: 'chatgpt-web' })) }); return; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: { message: 'method not allowed' } }); return; }
    let body;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: { message: 'bad json' } }); return; }
    const wantStream = body.stream === true;
    try {
      if (p === '/responses' || p === '/v1/responses') return await handleResponses(instId, res, body, wantStream);
      if (p === '/chat/completions' || p === '/v1/chat/completions') return await handleChat(instId, res, body, wantStream);
      sendJson(res, 404, { error: { message: 'unknown path ' + p } });
    } catch (e) { if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } }); else res.end(); }
  };
}

function listenOn(handler, port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function portInUse(port) {
  for (const v of servers.values()) if (v.port === port) return true;
  return false;
}

// 启动某实例的 server（幂等）；conf 里存过端口/token 则沿用，否则新分配
async function start(instId) {
  if (servers.has(instId)) return statusOf(instId);
  const conf = loadConf();
  conf.instances = conf.instances || {};
  const saved = conf.instances[instId] || {};
  let port = saved.port || DEFAULT_PORT;
  while (portInUse(port)) port += 1;
  const token = saved.token || id('cgw');
  const handler = makeOnRequest(instId);
  let srv = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { srv = await listenOn(handler, port); break; }
    catch (e) { if (e.code === 'EADDRINUSE') { port += 1; continue; } throw e; }
  }
  if (!srv) throw new Error('无可用端口');
  servers.set(instId, { server: srv, port, token });
  conf.instances[instId] = { port, token };
  saveConf(conf);
  log(`实例 ${instId} 监听 127.0.0.1:${port}`);
  return statusOf(instId);
}

function stop(instId) {
  const s = servers.get(instId);
  if (s && s.server) { try { s.server.close(); } catch {} }
  servers.delete(instId);
}
function stopAll() { for (const k of [...servers.keys()]) stop(k); }

// 彻底移除实例：停 server + 从 conf 删除记录
function forget(instId) {
  stop(instId);
  const conf = loadConf();
  if (conf.instances && conf.instances[instId]) { delete conf.instances[instId]; saveConf(conf); }
}

function statusOf(instId) {
  const s = servers.get(instId);
  return { id: instId, running: !!s, port: s ? s.port : null, token: s ? s.token : null, models: WEB_MODELS };
}
function status() { return { instances: [...servers.keys()].map(statusOf), models: WEB_MODELS, confPath: CONF_PATH }; }

module.exports = { start, stop, stopAll, forget, statusOf, status, DEFAULT_PORT, WEB_MODELS };
