// client/electron/route-policy-runtime.js
// 自进化路由 · 运行时单例 —— 把 route-policy 的 Beta 后验接进网关：持久化 + 排序 + reward 回灌。
// 「自适应(adaptive)」策略经由此模块工作（routing-strategies.js 的 case 'adaptive'）。
//
// 落盘：userData/route-policy.json（去抖写）。冷启动无数据时 rankCandidates 返回 null，
// 由调用方退回「综合最优(auto)」——即上线即安全、越用越准。
'use strict';

const fs = require('fs');
const path = require('path');
const { RoutePolicy } = require('./route-policy');
const { bucketOf } = require('./route-bucket');

let policy = null;
let filePath = null;
let dirty = false;
let saveTimer = null;
let updatesSinceDecay = 0;

const SAVE_DEBOUNCE_MS = 5000;
const DECAY_EVERY = 400;   // 每积累这么多次 reward 做一次遗忘衰减（跟上源漂移）

function init(dbDir) {
  if (!dbDir) return;
  filePath = path.join(dbDir, 'route-policy.json');
  policy = null;
  dirty = false;
  updatesSinceDecay = 0;
  try {
    if (fs.existsSync(filePath)) {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      policy = RoutePolicy.fromJSON(j);
    }
  } catch (e) {
    console.error('[route-policy] load failed:', e.message);
  }
  if (!policy) policy = new RoutePolicy();
}

function ensure() {
  if (!policy) policy = new RoutePolicy();
  return policy;
}

// v1：只用最细桶键、关掉退避（读/写一致）；任务类型维待后续启发式/embedding 上线再开退避。
function mkBucket(reqCtx) {
  const key = bucketOf(reqCtx || {}).key;
  return { key, backoffChain: [key] };
}

function markDirty() {
  dirty = true;
  if (saveTimer || !filePath) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (!dirty || !policy || !filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(policy.toJSON()));
    dirty = false;
  } catch (e) {
    console.error('[route-policy] save failed:', e.message);
  }
}

/**
 * 用 Thompson 采样给候选 (源,模型) 排序。
 * @param {{providerId,model,...}[]} cands
 * @param {object} reqCtx  请求特征（modality/input_tokens/text/caller）
 * @returns {Array|null}   排好序的候选；该桶下所有候选模型都无样本(冷启动) → 返回 null（调用方退 auto）
 */
function rankCandidates(cands, reqCtx) {
  const arr = Array.isArray(cands) ? cands : [];
  if (arr.length <= 1) return null;
  const p = ensure();
  const bucket = mkBucket(reqCtx);
  const models = [...new Set(arr.map(c => c && c.model).filter(Boolean))];
  const row = p.table.get(bucket.key);
  const hasData = row && models.some(m => (row.get(m)?.n || 0) > 0);
  if (!hasData) return null;   // 冷启动：交给 auto
  const ranked = p.rank(bucket, models);
  const pos = new Map(ranked.map((r, i) => [r.model, i]));
  // 稳定排序：按采样名次；同模型多源保持原相对序（源内选择仍归 cost/speed 上游已排）
  return arr
    .map((c, i) => [c, i])
    .sort((a, b) => ((pos.get(a[0].model) ?? 1e9) - (pos.get(b[0].model) ?? 1e9)) || (a[1] - b[1]))
    .map(x => x[0]);
}

/**
 * 回灌奖励。v1 奖励只用「成功」项（success=1 / fail=0）；延迟/成本/质量待后续加权。
 * 对所有「模型无关的策略路由」都记（即便本次策略不是 adaptive）——等于用真实流量给后验暖启动。
 */
function recordReward(reqCtx, model, reward01) {
  if (!model) return;
  const p = ensure();
  const bucket = mkBucket(reqCtx);
  p.update(bucket.key, model, reward01);
  markDirty();
  if (++updatesSinceDecay >= DECAY_EVERY) { updatesSinceDecay = 0; p.decay(); }
}

function snapshot() {
  return policy ? policy.toJSON() : null;
}

module.exports = { init, rankCandidates, recordReward, mkBucket, snapshot, flush };
