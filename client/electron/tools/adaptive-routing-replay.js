#!/usr/bin/env node
// tools/adaptive-routing-replay.js
// 自进化路由 · 离线回放评估器 —— 拿 local-stats.db 的真实请求，看 Thompson 策略
// （route-policy.js）相对「静态默认 / 实际发生 / 上帝视角」四条基线的效果。
//
// **不接实时路由**：只离线回放看效果，对应用户「先写一版、不加到路由列表、先看效果」。
//
// 方法（诚实说明其局限）：
//   1) 世界模型：从全量数据统计每个 (桶, 模型) 的经验成功率 p(b,m)；某组合无样本时回退该模型全局成功率
//      （off-policy 插值 —— 我们只观测到「实际被选中的模型」的真实结果，反事实奖励只能用同类经验近似）。
//   2) 按时间顺序回放 6826 条：每条请求归桶，Thompson 从候选池采样挑模型，用 Bernoulli(p(b,选中))
//      当反事实奖励并回灌后验；同时记录三条基线。
//   3) 桶：本回放用 size(input+cache_read) × 模态 —— DB 未存 prompt 文本，任务类型统一 other
//      （生产里会再按启发式/embedding 细分，见 route-bucket.js）。
//   4) 奖励只用「成功」一项（无延迟/成本/质量项）——展示自进化最硬的一环：自动淘汰必挂模型。
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { bucketOf, sizeTierOf } = require('../route-bucket');
const { RoutePolicy } = require('../route-policy');

const DB_PATH = process.argv[2]
  || path.join(process.env.APPDATA || '', 'llm-proxy-client', 'local-stats.db');

// 可复现 PRNG（mulberry32）—— 让每次回放结果一致
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 成功口径：无 error 且 status_code 非 4xx/5xx（会话补录行 status 为 null = 正常收尾）
function rowOk(r) {
  if (r.error != null && String(r.error) !== '') return false;
  if (r.status_code != null && r.status_code >= 400) return false;
  return true;
}
// 桶维·模态：DB 无 reqPath，用模型名猜（生图/向量模型另分），其余当 text
function modalityGuess(model) {
  const m = String(model || '').toLowerCase();
  if (/image|vision|flux|dall|sdxl|agnes-image|seedream|qwen-image/.test(m)) return 'vision';
  if (/embed|bge|gte|m3e/.test(m)) return 'embedding';
  return 'text';
}
// 占位/合成名（<synthetic> 等）不是真实可路由模型，排除出候选池
function isRealModel(model) {
  const m = String(model || '').trim();
  return m && !m.startsWith('<');
}
function bucketKeyOf(r) {
  const eff = (Number(r.input_tokens) || 0) + (Number(r.cache_read_tokens) || 0);
  return `${sizeTierOf(eff)}|${modalityGuess(r.model)}`;
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(
    `SELECT ts, model, status_code, error, input_tokens, cache_read_tokens, data_source
     FROM requests WHERE model IS NOT NULL ORDER BY ts ASC`
  ).all();

  // ── 候选池：只取 chat 类、全局样本 >=30 的模型（route 候选就是这些）
  const globalN = new Map(), globalOk = new Map();
  for (const r of rows) {
    if (modalityGuess(r.model) !== 'text' || !isRealModel(r.model)) continue;
    globalN.set(r.model, (globalN.get(r.model) || 0) + 1);
    if (rowOk(r)) globalOk.set(r.model, (globalOk.get(r.model) || 0) + 1);
  }
  const POOL = [...globalN.entries()].filter(([, n]) => n >= 30).map(([m]) => m);
  const gRate = (m) => (globalOk.get(m) || 0) / Math.max(1, globalN.get(m) || 0);

  // ── 世界模型 p(桶,模型)
  const cellN = new Map(), cellOk = new Map(); // `${bucket}::${model}`
  for (const r of rows) {
    if (modalityGuess(r.model) !== 'text') continue;
    const k = bucketKeyOf(r) + '::' + r.model;
    cellN.set(k, (cellN.get(k) || 0) + 1);
    if (rowOk(r)) cellOk.set(k, (cellOk.get(k) || 0) + 1);
  }
  const worldP = (bucket, model) => {
    const k = bucket + '::' + model;
    const n = cellN.get(k) || 0;
    if (n >= 8) return (cellOk.get(k) || 0) / n;   // 该组合样本够 → 用它
    return gRate(model);                            // 否则回退模型全局成功率
  };

  // ── 回放
  const rng = mulberry32(42);
  const policy = new RoutePolicy({ gamma: 0.97, minSamples: 20, rng: mulberry32(7) });
  const staticDefault = [...globalN.entries()].sort((a, b) => b[1] - a[1])[0][0]; // 最常用模型当「静态默认」

  const acc = { actual: 0, staticD: 0, thompson: 0, oracle: 0, n: 0 };
  const bucketEvents = new Map();
  // 分段收敛：把回放切 10 段看 Thompson 成功率随时间变化
  const SEG = 10;
  const seg = Array.from({ length: SEG }, () => ({ n: 0, ok: 0 }));
  const textRows = rows.filter(r => modalityGuess(r.model) === 'text');

  textRows.forEach((r, i) => {
    const bucket = bucketKeyOf(r);
    bucketEvents.set(bucket, (bucketEvents.get(bucket) || 0) + 1);

    // 1) 实际发生
    acc.actual += rowOk(r) ? 1 : 0;

    // 2) 静态默认
    acc.staticD += rng() < worldP(bucket, staticDefault) ? 1 : 0;

    // 3) Thompson
    const ranked = policy.rank({ key: bucket, backoffChain: [bucket, '*'] }, POOL);
    const pick = ranked[0];
    const rw = rng() < worldP(bucket, pick.model) ? 1 : 0;
    policy.update(pick.usedBucket, pick.model, rw);
    acc.thompson += rw;
    const s = Math.min(SEG - 1, Math.floor((i / textRows.length) * SEG));
    seg[s].n++; seg[s].ok += rw;

    // 4) 上帝视角（每桶最优模型的期望成功率上界）
    let best = 0;
    for (const m of POOL) best = Math.max(best, worldP(bucket, m));
    acc.oracle += best;

    acc.n++;
    if (i % 800 === 799) policy.decay(); // 周期性遗忘，演示非平稳
  });

  // ── 报告
  const pct = (x) => (100 * x / acc.n).toFixed(1) + '%';
  console.log('════════ 自进化路由 · 离线回放 ════════');
  console.log(`DB: ${DB_PATH}`);
  console.log(`文本类请求: ${acc.n} 条   候选池(${POOL.length}): ${POOL.join(', ')}`);
  console.log(`静态默认模型 = 最常用 = ${staticDefault}`);
  console.log('\n── 总体成功率（越高越好）──');
  console.log(`  实际发生      ${pct(acc.actual)}`);
  console.log(`  静态默认      ${pct(acc.staticD)}`);
  console.log(`  Thompson 自进化 ${pct(acc.thompson)}   ← 学出来的`);
  console.log(`  上帝视角(上界)  ${pct(acc.oracle)}`);

  console.log('\n── Thompson 成功率随回放推进（10 段，看收敛）──');
  console.log('  ' + seg.map((s, i) => `${i}:${s.n ? (100 * s.ok / s.n).toFixed(0) : '-'}%`).join('  '));

  console.log('\n── 各桶：Thompson 最终收敛到哪个模型 ──');
  const buckets = [...bucketEvents.entries()].sort((a, b) => b[1] - a[1]);
  for (const [bk, ev] of buckets) {
    const post = policy.posterior(bk).filter(p => p.n > 0);
    if (!post.length) continue;
    const top = post[0];
    const share = (100 * ev / acc.n).toFixed(0);
    console.log(`  [${bk}] ${String(ev).padStart(4)}条(${share}%) → ${top.model}  均值${top.mean.toFixed(3)} (α=${top.alpha.toFixed(0)},β=${top.beta.toFixed(0)})`);
  }

  // 挑流量最大的桶，展示「必挂模型被自动饿死」
  const bigBucket = buckets[0][0];
  console.log(`\n── 最大桶 [${bigBucket}] 各候选后验（看必挂模型如何塌到左边）──`);
  for (const p of policy.posterior(bigBucket)) {
    const bar = '█'.repeat(Math.round(p.mean * 20)).padEnd(20, '·');
    console.log(`  ${String(p.model).padEnd(28)} ${bar} ${p.mean.toFixed(3)}  n=${p.n}  worldP=${worldP(bigBucket, p.model).toFixed(2)}`);
  }

  db.close();
}

main();
