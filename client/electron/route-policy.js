// client/electron/route-policy.js
// 自进化路由 · 策略层（上下文老虎机 + Thompson 采样）—— ADAPTIVE-ROUTING-DESIGN.md §4.2。
//
// 维护 (桶, 模型) → 奖励后验 Beta(α, β)；路由时从每个候选后验各采一个数、取最大者
// （探索量自动正比于不确定度，无需手调 ε）。拿到结果后按 reward∈[0,1] 分数累加更新。
// 非平稳（源漂移）用计数衰减 α←1+γ(α-1)。
//
// **尚未接进实时路由**：先独立成模块 + 回放脚本（tools/adaptive-routing-replay.js）看效果。
// 纯 JS、零依赖、状态可序列化（后续可落 SQLite / config）。
'use strict';

const { bucketOf } = require('./route-bucket');

// ── 采样：Beta(α,β) = Gamma(α)/(Gamma(α)+Gamma(β))。用 Marsaglia-Tsang 采 Gamma，纯 JS。
function _sampleGamma(k, rng) {
  if (k < 1) {
    // Johnk / boost：Gamma(k) = Gamma(k+1) · U^(1/k)
    const u = rng();
    return _sampleGamma(1 + k, rng) * Math.pow(u === 0 ? Number.MIN_VALUE : u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = _gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
// Box-Muller（无状态：每次算一对、只取一个，避免跨 rng 流串用缓存的 spare）
function _gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleBeta(alpha, beta, rng = Math.random) {
  const x = _sampleGamma(Math.max(1e-6, alpha), rng);
  const y = _sampleGamma(Math.max(1e-6, beta), rng);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

class RoutePolicy {
  /**
   * @param {object} opts
   *   opts.gamma       计数衰减因子（0.90~0.99，越小越快遗忘旧证据）
   *   opts.minSamples  细桶样本 < 此数则沿 backoffChain 退父桶（默认 30）
   *   opts.priorAlpha  先验 α（默认 1 = 均匀 Beta(1,1)）
   *   opts.priorBeta   先验 β（默认 1）
   *   opts.rng         注入的 [0,1) 随机源（测试/回放用可复现 PRNG）
   */
  constructor(opts = {}) {
    this.gamma = opts.gamma ?? 0.95;
    this.minSamples = opts.minSamples ?? 30;
    this.priorAlpha = opts.priorAlpha ?? 1;
    this.priorBeta = opts.priorBeta ?? 1;
    this.rng = opts.rng || Math.random;
    // bucketKey → (model → {alpha, beta, n})
    this.table = new Map();
  }

  _cell(bucketKey, model) {
    let row = this.table.get(bucketKey);
    if (!row) { row = new Map(); this.table.set(bucketKey, row); }
    let c = row.get(model);
    if (!c) { c = { alpha: this.priorAlpha, beta: this.priorBeta, n: 0 }; row.set(model, c); }
    return c;
  }

  /** 沿 backoffChain 找样本量够的最细桶键（先粗后细的反向：从细往粗退） */
  _resolveBucketKey(backoffChain, model) {
    for (const k of backoffChain) {
      const c = this.table.get(k)?.get(model);
      if (c && c.n >= this.minSamples) return k;
    }
    // 都不足 → 用最细桶（让它积累）
    return backoffChain[0];
  }

  /**
   * 给候选模型排序（Thompson）。返回按采样值降序的候选数组，可直接当 failover 顺序。
   * @param {object|string} ctxOrBucket  ctx（走 bucketOf）或已算好的 bucket 对象
   * @param {string[]} candidates        候选模型名
   * @returns {{ model, theta, alpha, beta, n, usedBucket }[]}
   */
  rank(ctxOrBucket, candidates = []) {
    const bucket = typeof ctxOrBucket === 'string'
      ? { key: ctxOrBucket, backoffChain: [ctxOrBucket, '*'] }
      : (ctxOrBucket.backoffChain ? ctxOrBucket : bucketOf(ctxOrBucket));
    const scored = candidates.map((model) => {
      const usedKey = this._resolveBucketKey(bucket.backoffChain, model);
      const c = this._cell(usedKey, model);
      const theta = sampleBeta(c.alpha, c.beta, this.rng);
      return { model, theta, alpha: c.alpha, beta: c.beta, n: c.n, usedBucket: usedKey };
    });
    scored.sort((a, b) => b.theta - a.theta);
    return scored;
  }

  /** 采样挑一个（rank 的第一名） */
  pick(ctxOrBucket, candidates = []) {
    const r = this.rank(ctxOrBucket, candidates);
    return r.length ? r[0].model : null;
  }

  /**
   * 回灌奖励。reward∈[0,1]（见设计 §4.3：成功/延迟/成本/运维罚的加权，先只跑成功也行）。
   * @param {string} bucketKey  记在哪个桶键（一般用 rank 返回的 usedBucket，或最细桶）
   */
  update(bucketKey, model, reward01) {
    const r = Math.max(0, Math.min(1, Number(reward01)));
    const c = this._cell(bucketKey, model);
    c.alpha += r;
    c.beta += 1 - r;
    c.n += 1;
  }

  /** 周期性遗忘：α←1+γ(α-1)，β←1+γ(β-1)，让旧证据淡出、跟上源漂移。 */
  decay(gamma = this.gamma) {
    for (const row of this.table.values()) {
      for (const c of row.values()) {
        c.alpha = 1 + gamma * (c.alpha - 1);
        c.beta = 1 + gamma * (c.beta - 1);
      }
    }
  }

  /** 某桶各模型后验均值（诊断/展示用） */
  posterior(bucketKey) {
    const row = this.table.get(bucketKey);
    if (!row) return [];
    return [...row.entries()]
      .map(([model, c]) => ({ model, mean: c.alpha / (c.alpha + c.beta), alpha: c.alpha, beta: c.beta, n: c.n }))
      .sort((a, b) => b.mean - a.mean);
  }

  toJSON() {
    const out = {};
    for (const [k, row] of this.table) {
      out[k] = {};
      for (const [m, c] of row) out[k][m] = { alpha: c.alpha, beta: c.beta, n: c.n };
    }
    return { gamma: this.gamma, minSamples: this.minSamples, table: out };
  }

  static fromJSON(j, opts = {}) {
    const p = new RoutePolicy({ gamma: j?.gamma, minSamples: j?.minSamples, ...opts });
    for (const [k, row] of Object.entries(j?.table || {})) {
      const m = new Map();
      for (const [model, c] of Object.entries(row)) m.set(model, { alpha: c.alpha, beta: c.beta, n: c.n || 0 });
      p.table.set(k, m);
    }
    return p;
  }
}

module.exports = { RoutePolicy, sampleBeta };
