// injected-driver.js — 在 chatgpt.com 页面上下文里跑的收发内核。
// 由 host.js 读取本文件内容、经 webContents.executeJavaScript 注入。
// 机制 port 自 miuuyy/codex-chatgpt-web 的 browser-worker（最小子集）：
// 真登录浏览器里往真 composer 打字、按 data-turn-id 绑定新 assistant turn、扫 .markdown 收流。
// 不做任何反爬/arkose；靠的是用户自己已登录的会话。
(function initTbChatgptWebDriver() {
  if (window.__tbCgw && window.__tbCgw.__v === 11) return '已就绪';

  const COMPOSER = [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    '[contenteditable="true"][data-lexical-editor="true"]',
  ].join(', ');
  const ASSISTANT_TURN = [
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ].join(', ');
  const STOP_BTN = '[data-testid="stop-button"]';
  const COPY_BTN = 'button[data-testid="copy-turn-action-button"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visibleComposer = () =>
    [...document.querySelectorAll(COMPOSER)].find((el) => {
      const b = el.getBoundingClientRect();
      return el.isConnected && (b.width > 0 || b.height > 0);
    }) || null;

  // 登录 = 有可见 composer（与 miuuyy assertAuthenticatedChatGptPage 一致）
  function isLoggedIn() {
    return !!visibleComposer();
  }

  // 诊断探针：看真实 DOM 上各候选选择器命中情况，用于修选择器
  function probe() {
    const cnt = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return -1; } };
    const turnTestids = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .slice(-4).map((e) => e.getAttribute('data-testid'));
    const authorRoles = [...document.querySelectorAll('[data-message-author-role]')]
      .slice(-4).map((e) => e.getAttribute('data-message-author-role'));
    const comp = visibleComposer();
    return {
      url: location.href,
      composer: cnt(COMPOSER),
      composerText: comp ? (comp.innerText || '').slice(0, 40) : null,
      sendBtn_testid: cnt('button[data-testid="send-button"]'),
      sendBtn_composerSend: cnt('button[data-testid="composer-send-button"]'),
      sendBtn_submitId: cnt('#composer-submit-button'),
      sendBtn_ariaSend: cnt('button[aria-label*="Send"]'),
      stopBtn: cnt(STOP_BTN),
      stopBtn_alt: cnt('button[aria-label*="Stop"]'),
      convTurns: cnt('[data-testid^="conversation-turn-"]'),
      assistantTurns: cnt(ASSISTANT_TURN),
      authorRoleEls: cnt('[data-message-author-role]'),
      assistantAuthor: cnt('[data-message-author-role="assistant"]'),
      markdown: cnt('.markdown'),
      copyBtn: cnt(COPY_BTN),
      lastTurnTestids: turnTestids,
      lastAuthorRoles: authorRoles,
    };
  }

  // 按元素而非 data-turn-id 认回合（ChatGPT 未必给 turn 元素挂 data-turn-id）
  function assistantTurns() {
    return [...document.querySelectorAll(ASSISTANT_TURN)].filter((el) => {
      const b = el.getBoundingClientRect();
      return el.isConnected && (b.width > 0 || b.height > 0);
    });
  }
  function assistantTurnCount() { return assistantTurns().length; }
  function turnAt(index) {
    const els = assistantTurns();
    if (!els.length) return null;
    if (index == null || index < 0 || index >= els.length) return els[els.length - 1];
    return els[index];
  }

  // 取一个 assistant turn 的答案文本：拼所有 .markdown 根的 innerText（最小版；
  // miuuyy 还会分 reasoning/commentary，P3 再细化）
  function turnText(turnEl) {
    if (!turnEl) return '';
    const roots = [...turnEl.querySelectorAll('.markdown')].filter(
      (c) => !c.parentElement?.closest('.markdown')
    );
    if (!roots.length) {
      // 流式早期可能还没 .markdown 包裹
      const alt = turnEl.querySelector('[data-message-author-role="assistant"]');
      return (alt || turnEl).innerText || '';
    }
    return roots.map((r) => r.innerText).join('\n\n').trim();
  }

  function turnHasCopy(turnEl) {
    return !!turnEl && !!turnEl.querySelector(COPY_BTN);
  }
  function anyStopVisible() {
    return [...document.querySelectorAll(STOP_BTN)].some((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 || b.height > 0;
    });
  }

  // 往 composer 填文本：execCommand insertText 被 Lexical 当真人输入（port 自 browser-worker 2050 行）
  function fillComposer(el, text) {
    el.focus();
    // 先清空
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text);
    // 触发 input，促使 Lexical 把文字登记进内部模型（否则发送按钮点了空转）
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text }));
  }

  function composerEmpty() {
    const el = visibleComposer();
    return !el || (el.innerText || '').trim() === '';
  }
  // 是否已真正发出：回合数增加 / 出现 stop 按钮 / composer 被清空
  function sentEvidence(beforeCount) {
    return assistantTurnCount() > beforeCount || anyStopVisible() || composerEmpty();
  }

  function findSendButton() {
    const sels = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      '#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'form button[type="submit"]',
    ];
    for (const s of sels) {
      const b = document.querySelector(s);
      if (b && !b.disabled) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) return b;
      }
    }
    return null;
  }

  async function fill(text) {
    const el = visibleComposer();
    if (!el) throw new Error('composer 不可见（可能未登录）');
    fillComposer(el, String(text ?? ''));
    for (let i = 0; i < 25; i += 1) { if (findSendButton()) return true; await sleep(60); }
    return !!findSendButton();
  }

  async function send(beforeCount) {
    const startCount = Number(beforeCount) || assistantTurnCount();
    let via = 'none';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const el = visibleComposer();
      const btn = findSendButton();
      if (btn) { btn.click(); via = 'button'; }
      else if (el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        via = 'enter';
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        if (sentEvidence(startCount)) return { beforeCount: startCount, via, attempt };
        await sleep(120);
      }
    }
    return { beforeCount: startCount, via, unsure: true };
  }

  async function submit(text) {
    const beforeCount = assistantTurnCount();
    const str = String(text ?? '');
    let via = 'none';
    // 提交并验证：最多 4 次；每次发出后 2.5s 内验证是否真发出，没发就重填重试
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const el = visibleComposer();
      if (!el) break;
      fillComposer(el, str);
      let btn = null;
      for (let i = 0; i < 25; i += 1) { btn = findSendButton(); if (btn) break; await sleep(60); }
      if (btn) { btn.click(); via = 'button'; }
      else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        via = 'enter';
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        if (sentEvidence(beforeCount)) return { beforeCount, via, attempt };
        await sleep(120);
      }
    }
    return { beforeCount, via, unsure: true };
  }

  function fileInputSelector() {
    const sels = [
      'input[data-testid="upload-photos-input"]',
      'input[data-testid="file-upload-input"]',
      'input[data-testid="composer-file-input"]',
      'form input[type="file"]',
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ];
    for (const s of sels) {
      if (document.querySelector(s)) return s;
    }
    return '';
  }

  function groupLabel(el) {
    const labelled = el.getAttribute('aria-label') || '';
    if (labelled) return labelled;
    const titled = el.querySelector('[title]');
    if (titled && titled.getAttribute('title')) return titled.getAttribute('title');
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function attachmentsStatus(names) {
    const list = Array.isArray(names) ? names : [];
    const sel = fileInputSelector();
    const input = sel ? document.querySelector(sel) : null;
    const inputCount = input && input.files ? input.files.length : 0;
    const labels = [...document.querySelectorAll('[role="group"]')].map(groupLabel);
    const missing = list.filter((n) => {
      const stem = String(n).replace(/\.[^.]+$/, '');
      return !labels.some((lb) => lb.includes(n) || (stem && lb.includes(stem)));
    });
    const chipsOk = missing.length === 0;
    const inputOk = list.length > 0 && inputCount >= list.length;
    return {
      ready: chipsOk || inputOk,
      missing,
      sendEnabled: !!findSendButton(),
      alerts: [...document.querySelectorAll('[role="alert"]')]
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      inputCount,
    };
  }

  // 绑定提交后新增的 assistant 回合：等回合数 > beforeCount，或 stop 按钮出现（已在生成）
  async function bindNewTurn(beforeCount, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (assistantTurnCount() > beforeCount) return assistantTurnCount() - 1; // 新回合的索引
      if (anyStopVisible() && assistantTurnCount() >= Math.max(1, beforeCount)) return assistantTurnCount() - 1;
      await sleep(100);
    }
    throw new Error('提交后未出现新的 assistant 回合（选择器可能需更新）');
  }

  // 轮询收流；串行下当前回复恒为最后一个 assistant 回合，直接读它，避免 index 漂移读空。
  // 返回细粒度信号，完成判定交给 host（需文本稳定），避免一有文本就误判完成而截断。
  function poll() {
    const els = assistantTurns();
    const el = els.length ? els[els.length - 1] : null;
    const text = turnText(el);
    return {
      text,
      hasCopy: turnHasCopy(el),
      stop: anyStopVisible(),
      exists: !!el,
      turns: assistantTurnCount(),
    };
  }

  // ——— markdown 段快照（port 自 miuuyy browser-worker 的 markdownSegments 提取）———
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
    'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
  ]);
  const renderedInDom = (el) => {
    if (!el || !el.isConnected) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 || b.height > 0;
  };
  function markdownTextOf(element) {
    const parts = [];
    const boundary = () => { if (parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n'); };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent || '');
      if (!(node instanceof HTMLElement)) return;
      const tag = node.tagName.toLowerCase();
      const block = BLOCK_TAGS.has(tag);
      if (block) boundary();
      if (tag === 'br') parts.push('\n');
      node.childNodes.forEach(visit);
      if (block) boundary();
    };
    visit(element);
    return parts.join('').trim();
  }
  function srcRange(el) {
    const s = el.getAttribute('data-start'); const e = el.getAttribute('data-end');
    if (s === null || e === null || !s.trim() || !e.trim()) return undefined;
    const a = Number(s); const b = Number(e);
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? { sourceStart: a, sourceEnd: b } : undefined;
  }
  // 分离答案根与思考/commentary 根（chain-of-thought、streaming-status 内、首个 status 之前的都算 commentary）
  function classifyAnswerRoots(roots, statusContainers) {
    const first = statusContainers[0];
    const commentary = roots.filter((c) => (
      c.closest('[data-streaming-response-status]') !== null
      || c.closest('[data-testid^="cot-v5"]') !== null
      || (first !== undefined && Boolean(c.compareDocumentPosition(first) & 4))
    ));
    return { answerRoots: roots.filter((c) => !commentary.includes(c)) };
  }
  function contentClone(root) {
    const content = root.cloneNode(true);
    for (const w of Array.from(content.querySelectorAll(
      '.chart-widget-container, [data-code-block-preview-pane], button, script, style, svg, img, picture, source'))) {
      w.remove();
    }
    return content;
  }
  // 产出最后一个 assistant 回合的 markdown 段 + 完成/生成信号
  function snapshot() {
    const els = assistantTurns();
    const root = els.length ? els[els.length - 1] : null;
    const base = { markdownSegments: [], visibleText: '', hasCopy: turnHasCopy(root), stop: anyStopVisible(), turns: els.length, exists: !!root };
    if (!root) return base;
    const allRoots = [...root.querySelectorAll('.markdown')]
      .filter((c) => !c.parentElement?.closest('.markdown'))
      .filter(renderedInDom);
    const statusContainers = [...root.querySelectorAll('[data-streaming-response-status]')].filter(renderedInDom);
    const { answerRoots } = classifyAnswerRoots(allRoots, statusContainers);

    const segs = [];
    let listGroup = 0;
    const appendBlock = (child) => {
      const tag = child.tagName.toLowerCase();
      const range = srcRange(child);
      const items = (tag === 'ol' || tag === 'ul')
        ? [...child.children].filter((c) => c.tagName === 'LI') : [];
      if (items.length === 0) {
        segs.push({ tag, html: child.outerHTML, text: markdownTextOf(child), ...range });
        return;
      }
      const group = range ? `list:${range.sourceStart}:${tag}` : `list:${listGroup++}:${tag}`;
      const orderedStart = tag === 'ol' ? Number(child.getAttribute('start') ?? '1') : undefined;
      items.forEach((item, i) => {
        const shell = child.cloneNode(false);
        shell.removeAttribute('data-is-last-node');
        if (orderedStart !== undefined && Number.isFinite(orderedStart)) shell.setAttribute('start', String(orderedStart + i));
        shell.append(item.cloneNode(true));
        segs.push({ tag: `${tag}:item`, html: shell.outerHTML, text: markdownTextOf(item), group, ...srcRange(item) });
      });
    };
    answerRoots.map(contentClone).forEach((mdRoot) => {
      const children = [...mdRoot.children];
      const hasBlock = children.some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()));
      if (!hasBlock) {
        if (mdRoot.innerHTML.trim()) segs.push({ tag: 'root', html: mdRoot.innerHTML, text: markdownTextOf(mdRoot), ...srcRange(mdRoot) });
        return;
      }
      let inlineRun = [];
      const flush = () => {
        if (!inlineRun.length) return;
        const nodes = inlineRun; inlineRun = [];
        const shell = document.createElement('span');
        nodes.forEach((n) => shell.append(n.cloneNode(true)));
        const text = markdownTextOf(shell);
        if (text) {
          const ranged = nodes.flatMap((n) => n instanceof Element ? [n, ...n.querySelectorAll('[data-start][data-end]')] : []);
          const ranges = ranged.map(srcRange).filter(Boolean);
          segs.push({ tag: 'inline', html: shell.outerHTML, text,
            ...(ranges.length ? { sourceStart: Math.min(...ranges.map((r) => r.sourceStart)), sourceEnd: Math.max(...ranges.map((r) => r.sourceEnd)) } : {}) });
        }
      };
      mdRoot.childNodes.forEach((node) => {
        if (node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName.toLowerCase())) { flush(); appendBlock(node); return; }
        inlineRun.push(node);
      });
      flush();
    });
    const markdownSegments = segs.map((s, index, arr) => ({
      key: s.sourceStart !== undefined ? `${s.sourceStart}:${s.tag}` : `${index}:${s.tag}`,
      tag: s.tag, html: s.html, text: s.text,
      ...(s.group ? { group: s.group } : {}),
      ...(s.sourceStart !== undefined ? { sourceStart: s.sourceStart } : {}),
      ...(s.sourceEnd !== undefined ? { sourceEnd: s.sourceEnd } : {}),
      streamable: index < arr.length - 1,
    }));
    base.markdownSegments = markdownSegments;
    base.visibleText = markdownSegments.map((s) => s.text).join('\n').trim();
    return base;
  }

  window.__tbCgw = {
    __v: 11,
    isLoggedIn,
    fill,
    send,
    submit,
    bindNewTurn,
    poll,
    snapshot,
    assistantTurnCount,
    probe,
    fileInputSelector,
    attachmentsStatus,
    hasSendButton: () => !!findSendButton(),
  };
  return '已就绪';
})();
