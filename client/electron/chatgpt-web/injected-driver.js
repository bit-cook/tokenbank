// injected-driver.js — 在 chatgpt.com 页面上下文里跑的收发内核。
// 由 host.js 读取本文件内容、经 webContents.executeJavaScript 注入。
// 机制 port 自 miuuyy/codex-chatgpt-web 的 browser-worker（最小子集）：
// 真登录浏览器里往真 composer 打字、按 data-turn-id 绑定新 assistant turn、扫 .markdown 收流。
// 不做任何反爬/arkose；靠的是用户自己已登录的会话。
(function initTbChatgptWebDriver() {
  if (window.__tbCgw && window.__tbCgw.__v === 7) return '已就绪';

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

  async function submit(text) {
    let el = visibleComposer();
    if (!el) throw new Error('composer 不可见（可能未登录）');
    const beforeCount = assistantTurnCount();
    const str = String(text ?? '');
    let via = 'none';
    // 提交并验证：最多 4 次；每次发出后 2.5s 内验证是否真发出，没发就重填重试
    for (let attempt = 0; attempt < 4; attempt += 1) {
      el = visibleComposer();
      if (!el) break;
      fillComposer(el, str);
      // 等发送按钮出现（文字登记后才 enable）
      let btn = null;
      for (let i = 0; i < 25; i += 1) { btn = findSendButton(); if (btn) break; await sleep(60); }
      if (btn) { btn.click(); via = 'button'; }
      else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        via = 'enter';
      }
      // 验证是否真发出
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        if (sentEvidence(beforeCount)) return { beforeCount, via, attempt };
        await sleep(120);
      }
      // 没发出去，下一轮重填重试
    }
    return { beforeCount, via, unsure: true };
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

  // 轮询收流；host 端每次调 poll(index) 拿当前文本+是否完成，自己算增量
  function poll(index) {
    const el = turnAt(index);
    const text = turnText(el);
    const done = turnHasCopy(el) || (!anyStopVisible() && text.length > 0);
    return { text, done, exists: !!el, turns: assistantTurnCount() };
  }

  window.__tbCgw = {
    __v: 7,
    isLoggedIn,
    submit,
    bindNewTurn,
    poll,
    assistantTurnCount,
    probe,
    hasSendButton: () => !!findSendButton(),
  };
  return '已就绪';
})();
