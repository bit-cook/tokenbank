// client/electron/route-bucket.js
// 自进化路由 · 分桶器（bucketing）—— ADAPTIVE-ROUTING-DESIGN.md §4.1 的落地。
//
// 本模块只做「把一个请求 ctx 归到一个语义/规模/模态桶」，纯函数、零依赖、不出网关。
// **尚未接进实时路由**（local-gateway 的 orderStepsByFlow 仍走静态顺序）；
// 先独立成模块 + 回放脚本看效果（见 tools/adaptive-routing-replay.js）。
//
// 桶 = (任务类型 × 规模档 × 模态)，caller 只做「偏置特征」不做桶维（数据里 Claude Code 占 77.6%，
// 乘进主键会把桶撑满、其它稀疏到学不动 —— 见设计 §4.1①）。
// 稀疏时按 n-gram 式分层退避：细桶样本不足 → 退父桶（见 backoffChain）。
'use strict';

// ── 规模档：用 input + cache_read（Claude 重度 prompt 缓存，真实上下文几乎全在 cache_read；
//    只看 raw input_tokens 均值仅 ~109、全落 S 档就全错 —— 见设计 §4.1②）。
const SIZE_TIERS = [
  { key: 'S', max: 8_000 },
  { key: 'M', max: 32_000 },
  { key: 'L', max: 128_000 },
  { key: 'XL', max: Infinity },
];
function sizeTierOf(effInputTokens) {
  const n = Number(effInputTokens) || 0;
  for (const t of SIZE_TIERS) if (n < t.max) return t.key;
  return 'XL';
}

// ── 模态：桶只区分 text / vision（tool-heavy 留待后续）。gateway 的 modalityOf 给的是
//    chat/image/video/embedding/audio；这里做一层收敛。
function modalityClassOf(modality) {
  switch (String(modality || 'chat')) {
    case 'image':
    case 'video':
      return 'vision';
    case 'embedding':
      return 'embedding';
    case 'audio':
      return 'audio';
    default:
      return 'text';
  }
}

// ── 任务类型：三级混合的「第 1 级 · 启发式先筛」（0 延迟，冷启动兜底；设计 §4.1）。
//    第 2 级本地 embedding 质心、第 3 级 LLM 分类器兜底留待 P1/P2；此处只落零成本正则。
//    命中优先级：debug > chore > qa > design > plan，明显信号先赢。
const TASK_RULES = [
  { key: 'debug',  re: /\b(traceback|stack ?trace|exception|err(or)?|bug|fix|failing|panic|throw[ns]?)\b|报错|异常|修复|栈|崩溃/i },
  { key: 'chore',  re: /\b(commit|docstring|rename|format(ting)?|lint|typo|import|boilerplate)\b|格式化|重命名|注释|提交信息/i },
  { key: 'qa',     re: /\b(what|why|how|where|when|explain|does|is there|如何|为什么|是什么|解释|怎么)\b.*\?|\?\s*$/i },
  { key: 'design', re: /\b(design|architect(ure)?|refactor|implement|build|feature|scaffold|plan out)\b|设计|架构|重构|实现|方案/i },
  { key: 'plan',   re: /\b(plan|roadmap|break ?down|steps?|milestone|todo)\b|计划|拆解|路线图|里程碑/i },
];
function taskTypeOf(text) {
  const s = String(text || '');
  if (!s.trim()) return 'other';
  for (const r of TASK_RULES) if (r.re.test(s)) return r.key;
  return 'other';
}

// caller 收敛成几大类（当偏置特征，非桶维）
function callerClassOf(caller) {
  const c = String(caller || '').toLowerCase();
  if (c.includes('claude-code') || c === 'session-claude') return 'claude-code';
  if (c.includes('codex')) return 'codex';
  if (c.includes('desktop')) return 'desktop';
  if (c.includes('cursor')) return 'cursor';
  return c || 'other';
}

/**
 * 把请求 ctx 归桶。
 * @param {object} ctx
 *   ctx.input_tokens        raw 输入 token（gateway estimateInputTokens / usage）
 *   ctx.cache_read_tokens   prompt 缓存命中 token（可选，强烈建议带上）
 *   ctx.modality            chat/image/video/embedding/audio（gateway modalityOf）
 *   ctx.text                拼接的输入文本（给启发式任务分类）
 *   ctx.caller              调用方（当偏置特征）
 *   ctx.task                若上游已给语义标签（classifier_label）则直接采信
 * @returns {{ key, task, size, modality, caller, backoffChain }}
 *   key           最细桶键 `task|size|modality`
 *   backoffChain  从细到粗的退避键数组：[task|size|modality, task|size, task, '*']
 */
function bucketOf(ctx = {}) {
  const eff = (Number(ctx.input_tokens) || 0) + (Number(ctx.cache_read_tokens) || 0);
  const size = sizeTierOf(eff);
  const modality = modalityClassOf(ctx.modality);
  const task = ctx.task || ctx.classifier_label || taskTypeOf(ctx.text);
  const caller = callerClassOf(ctx.caller);

  const key = `${task}|${size}|${modality}`;
  const backoffChain = [
    key,
    `${task}|${size}`,
    `${task}`,
    '*',
  ];
  return { key, task, size, modality, caller, backoffChain };
}

module.exports = {
  bucketOf,
  sizeTierOf,
  modalityClassOf,
  taskTypeOf,
  callerClassOf,
  SIZE_TIERS,
};
