// markdown.js — port 自 miuuyy/codex-chatgpt-web 的 markdown.ts（TS→JS）。
// chatGptHtmlToMarkdown：HTML→Markdown（turndown + gfm，去按钮/脚本/图片/svg，紧凑列表、内联文件路径链接）。
// ChatGptMarkdownBuffer：把 DOM 里「结构上已完成的块」转成 append-only 的 Markdown 流：
//   一个段只有在 streamable（后面已有新段）且稳定 stabilityMs 后才提交，避免提交后又被 ChatGPT 改写。
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});
turndown.use(gfm);
turndown.remove(['button', 'script', 'style']);
turndown.addRule('removeImages', {
  filter: (node) => ['IMG', 'PICTURE', 'SOURCE'].includes(node.nodeName),
  replacement: () => '',
});
turndown.addRule('removeSvg', {
  filter: (node) => node.nodeName === 'SVG',
  replacement: () => '',
});
turndown.addRule('linkInlineFilePaths', {
  filter: (node) => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const p = node.textContent;
    const target = p.replaceAll('\\', '/');
    return `[${p}](<${target}>)`;
  },
});
turndown.addRule('compactListItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    const parent = node.parentNode;
    let prefix = `${options.bulletListMarker} `;
    if (parent && parent.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start') ?? '1');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, '')
      .replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? '\n' : ''}`;
  },
});

function inlineFilePath(node) {
  if (node.nodeName !== 'CODE') return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (['A', 'PRE'].includes(ancestor.nodeName)) return undefined;
  }
  const p = node.textContent ?? '';
  if (p !== p.trim() || /[\s`<>()[\]]/.test(p)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(p)) return undefined;
  const withoutLocation = p.replace(/:\d+(?::\d+)?$/, '');
  const separator = Math.max(withoutLocation.lastIndexOf('/'), withoutLocation.lastIndexOf('\\'));
  if (separator < 0) return undefined;
  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return p;
}

function chatGptHtmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  return turndown.turndown(html).trim();
}

class ChatGptMarkdownConsistencyError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'ChatGptMarkdownConsistencyError';
    this.diagnostic = diagnostic;
  }
}

class ChatGptMarkdownBuffer {
  constructor(transform = (m) => m, stabilityMs = 750) {
    this.transform = transform;
    this.stabilityMs = stabilityMs;
    this.candidates = new Map();
    this.committed = [];
    this.latest = [];
    this.markdown = '';
    this.lastGroup = undefined;
    this.consistencyError = undefined;
  }

  observe(segments, now = Date.now()) {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled;
      return '';
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map((s) => ({ ...s }));

    const visible = new Set();
    for (const seg of reconciled) {
      const id = this.candidateId(seg);
      visible.add(id);
      const prev = this.candidates.get(id);
      const unchanged = prev
        && prev.key === seg.key && prev.tag === seg.tag && prev.html === seg.html
        && prev.text === seg.text && prev.group === seg.group
        && prev.sourceStart === seg.sourceStart && prev.sourceEnd === seg.sourceEnd;
      this.candidates.set(id, {
        ...seg,
        changedAt: unchanged ? prev.changedAt : now,
        ...(seg.streamable ? {
          streamableAt: unchanged && prev.streamableAt !== undefined ? prev.streamableAt : now,
        } : {}),
      });
    }
    for (const id of [...this.candidates.keys()]) {
      if (!visible.has(id)) this.candidates.delete(id);
    }

    let delta = '';
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const seg = reconciled[committedCount];
      const id = this.candidateId(seg);
      const cand = this.candidates.get(id);
      if (!cand || !cand.streamable || cand.streamableAt === undefined) break;
      if (now - Math.max(cand.changedAt, cand.streamableAt) < this.stabilityMs) break;
      delta += this.commit(cand);
      this.committed.push(this.committedSegment(cand));
      this.candidates.delete(id);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish() {
    if (this.consistencyError) throw this.consistencyError;
    let delta = '';
    for (const seg of this.latest) {
      delta += this.commit(seg);
      this.committed.push(this.committedSegment(seg));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent() { return this.consistencyError === undefined; }

  reconcile(segments) {
    if (this.committed.length === 0 || segments.length === 0) return segments;
    const pending = [];
    const lastRangedCommitted = [...this.committed].filter((s) => s.sourceEnd !== undefined).at(-1);
    const lastCommittedEnd = lastRangedCommitted ? lastRangedCommitted.sourceEnd : undefined;
    let highestCommittedIndex = -1;
    let sawPending = false;
    let previousSourceStart;
    for (const seg of segments) {
      if (seg.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && seg.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError('ChatGPT final DOM exposed non-monotonic source ranges');
        }
        previousSourceStart = seg.sourceStart;
      }
      const idx = this.committedIndex(seg);
      if (idx !== undefined) {
        const committed = this.committed[idx];
        if (sawPending || idx < highestCommittedIndex || committed.text !== seg.text) {
          return this.changedCommittedBlockError(
            sawPending || idx < highestCommittedIndex ? 'block_order_changed' : 'text_changed', seg, committed);
        }
        highestCommittedIndex = idx;
        continue;
      }
      if (seg.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (seg.sourceStart <= lastCommittedEnd) {
          return this.changedCommittedBlockError('source_range_overlap', seg, lastRangedCommitted);
        }
        sawPending = true; pending.push(seg); continue;
      }
      const followsVisibleTail = highestCommittedIndex === this.committed.length - 1;
      if (!followsVisibleTail && !this.matchesLatestPending(seg)) {
        return new ChatGptMarkdownConsistencyError('ChatGPT final DOM could not be aligned with text already streamed');
      }
      sawPending = true; pending.push(seg);
    }
    return pending;
  }

  committedIndex(seg) {
    const exact = this.committed.findIndex((c) => (
      seg.sourceStart !== undefined && c.sourceStart !== undefined
        ? seg.sourceStart === c.sourceStart && seg.tag === c.tag
        : seg.key === c.key));
    if (exact >= 0) return exact;
    if (seg.sourceStart !== undefined) return undefined;
    if (!seg.tag) return undefined;
    const matches = this.committed
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => c.tag === seg.tag && c.text === seg.text);
    return matches.length === 1 ? matches[0].index : undefined;
  }

  matchesLatestPending(seg) {
    const exact = this.latest.filter((c) => (
      seg.sourceStart !== undefined && c.sourceStart !== undefined
        ? seg.sourceStart === c.sourceStart && seg.tag === c.tag
        : seg.key === c.key));
    if (exact.length === 1) return true;
    if (seg.sourceStart !== undefined) return false;
    if (!seg.tag) return false;
    return this.latest.filter((c) => c.tag === seg.tag && c.text === seg.text).length === 1;
  }

  candidateId(seg) {
    return seg.sourceStart !== undefined ? `source:${seg.sourceStart}:${seg.tag ?? ''}` : `key:${seg.key}`;
  }

  committedSegment(seg) {
    return {
      key: seg.key,
      ...(seg.tag ? { tag: seg.tag } : {}),
      text: seg.text,
      ...(seg.sourceStart !== undefined ? { sourceStart: seg.sourceStart } : {}),
      ...(seg.sourceEnd !== undefined ? { sourceEnd: seg.sourceEnd } : {}),
    };
  }

  changedCommittedBlockError(reason, observed, committed) {
    return new ChatGptMarkdownConsistencyError(
      'ChatGPT changed a completed text block that was already streamed',
      {
        reason,
        observedStart: observed.sourceStart, observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart, committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length, committedTextChars: committed.text.length,
      });
  }

  commit(seg) {
    const block = this.transform(chatGptHtmlToMarkdown(seg.html));
    if (!block) return '';
    const separator = this.markdown
      ? (seg.group !== undefined && seg.group === this.lastGroup ? '\n' : '\n\n')
      : '';
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = seg.group;
    return delta;
  }
}

module.exports = { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError };
