'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bucketOf, sizeTierOf, taskTypeOf, callerClassOf } = require('../route-bucket');
const { RoutePolicy, sampleBeta } = require('../route-policy');

// 可复现 PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('sizeTierOf：按 input+cache_read 分档 S/M/L/XL', () => {
  assert.equal(sizeTierOf(0), 'S');
  assert.equal(sizeTierOf(7999), 'S');
  assert.equal(sizeTierOf(8000), 'M');
  assert.equal(sizeTierOf(31999), 'M');
  assert.equal(sizeTierOf(32000), 'L');
  assert.equal(sizeTierOf(200000), 'XL');
});

test('taskTypeOf：启发式抓明显信号', () => {
  assert.equal(taskTypeOf('这里报错了 stack trace 帮我修复'), 'debug');
  assert.equal(taskTypeOf('帮我写个 commit message'), 'chore');
  assert.equal(taskTypeOf('为什么这段代码会这样?'), 'qa');
  assert.equal(taskTypeOf('设计一个订单模块的架构'), 'design');
  assert.equal(taskTypeOf(''), 'other');
});

test('bucketOf：桶键 = task|size|modality，caller 只当偏置、退避链从细到粗', () => {
  const b = bucketOf({ input_tokens: 100, cache_read_tokens: 200000, modality: 'chat', text: '设计架构', caller: 'session-claude' });
  assert.equal(b.key, 'design|XL|text');
  assert.equal(b.caller, 'claude-code'); // 不进 key
  assert.deepEqual(b.backoffChain, ['design|XL|text', 'design|XL', 'design', '*']);
});

test('sampleBeta：极尖后验采样落在均值附近', () => {
  const rng = mulberry32(1);
  let s = 0; const N = 2000;
  for (let i = 0; i < N; i++) s += sampleBeta(3703, 77, rng); // ≈claude 0.98
  assert.ok(Math.abs(s / N - 0.98) < 0.02);
});

test('RoutePolicy：从「一个必挂模型 + 一个稳模型」里学会只选稳的', () => {
  const policy = new RoutePolicy({ rng: mulberry32(9), minSamples: 5 });
  const bucket = { key: 'design|XL|text', backoffChain: ['design|XL|text', '*'] };
  const world = { good: 0.98, bad: 0.02 };
  const draw = mulberry32(123);
  let goodPicks = 0;
  for (let i = 0; i < 400; i++) {
    const pick = policy.pick(bucket, ['good', 'bad']);
    if (pick === 'good') goodPicks++;
    const rw = draw() < world[pick] ? 1 : 0;
    policy.update(bucket.key, pick, rw);
  }
  // 后 100 次几乎全选 good
  assert.ok(goodPicks > 320, `goodPicks=${goodPicks}`);
  const post = policy.posterior('design|XL|text');
  assert.equal(post[0].model, 'good');
  assert.ok(post[0].mean > 0.9);
});

test('RoutePolicy：decay 让旧证据淡出（α/β 向 1 收缩）', () => {
  const policy = new RoutePolicy({ rng: mulberry32(3) });
  for (let i = 0; i < 50; i++) policy.update('b', 'm', 1);
  const before = policy.posterior('b')[0];
  policy.decay(0.5);
  const after = policy.posterior('b')[0];
  assert.ok(after.alpha < before.alpha);
  assert.ok(after.alpha > 1);
});

test('toJSON / fromJSON 往返', () => {
  const p = new RoutePolicy({ rng: mulberry32(2) });
  p.update('b', 'm', 1); p.update('b', 'm', 0);
  const j = p.toJSON();
  const p2 = RoutePolicy.fromJSON(j);
  assert.deepEqual(p2.toJSON().table, j.table);
});

test('callerClassOf：收敛调用方大类', () => {
  assert.equal(callerClassOf('session-claude'), 'claude-code');
  assert.equal(callerClassOf('codex-desktop'), 'codex');
  assert.equal(callerClassOf('cursor'), 'cursor');
});

// ── 运行时（rankCandidates 冷启动/学习 + reward 回灌 + 持久化）──
const fs = require('fs');
const os = require('os');
const path = require('path');

test('runtime：冷启动无数据 → rankCandidates 返回 null（调用方退 auto）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rp-'));
  const rt = require('../route-policy-runtime');
  rt.init(dir);
  const cands = [{ providerId: 'a', model: 'good' }, { providerId: 'b', model: 'bad' }];
  const ctx = { modality: 'chat', input_tokens: 200000, text: '设计架构', caller: 'session-claude' };
  assert.equal(rt.rankCandidates(cands, ctx), null);
});

test('runtime：回灌后 rankCandidates 把学到的稳模型排前，且能落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-rp-'));
  const rt = require('../route-policy-runtime');
  rt.init(dir);
  const ctx = { modality: 'chat', input_tokens: 200000, text: '设计架构', caller: 'session-claude' };
  const cands = [{ providerId: 'a', model: 'good' }, { providerId: 'b', model: 'bad' }];
  for (let i = 0; i < 40; i++) { rt.recordReward(ctx, 'good', 1); rt.recordReward(ctx, 'bad', 0); }
  const out = rt.rankCandidates(cands, ctx);
  assert.ok(out && out[0].model === 'good', 'good 应排第一');
  rt.flush();
  assert.ok(fs.existsSync(path.join(dir, 'route-policy.json')));
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'route-policy.json'), 'utf8'));
  assert.ok(j.table['design|XL|text'], '桶键落盘');
});
