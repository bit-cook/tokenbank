'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const localStats = require('../local-stats');
const { estimateListCost } = require('../pricing');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stats-savings-'));
}

function withDb(fn) {
  const dir = tmpDir();
  try {
    localStats.init(dir, { force: true });
    fn();
  } finally {
    localStats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('free-tier proxy calls are priced at the requested model list price', () => {
  withDb(() => {
    localStats.record({
      provider_id: 'ollama', model: 'qwen3-coder:30b', requested_model: 'claude-sonnet-4-6',
      tier: 'free', input_tokens: 1_000_000, output_tokens: 100_000,
      data_source: 'proxy', billing_type: 'api-key', cost_usd: 0,
    });
    const dash = localStats.queryDashboard(30);
    // sonnet: $3/M in + $15/M out → 3 + 1.5
    assert.equal(dash.routing_savings.calls, 1);
    assert.ok(Math.abs(dash.routing_savings.usd - 4.5) < 1e-9, `got ${dash.routing_savings.usd}`);
  });
});

test('paid, p2p, failed and session-imported calls do not count as savings', () => {
  withDb(() => {
    const base = { input_tokens: 1000, output_tokens: 1000, billing_type: 'api-key', requested_model: 'claude-sonnet-4-6' };
    localStats.record({ ...base, provider_id: 'a', model: 'gpt-4o', tier: 'paid', data_source: 'proxy' });
    localStats.record({ ...base, provider_id: 'b', model: 'gpt-4o', tier: 'p2p', data_source: 'proxy' });
    localStats.record({ ...base, provider_id: 'c', model: 'gpt-4o', tier: 'free', data_source: 'proxy', status_code: 502 });
    localStats.record({ ...base, provider_id: 'd', model: 'gpt-4o', tier: 'free', data_source: 'session:claude' });
    const dash = localStats.queryDashboard(30);
    assert.equal(dash.routing_savings.calls, 0);
    assert.equal(dash.routing_savings.usd, 0);
  });
});

test('unknown models are not priced with the fallback rate', () => {
  assert.equal(estimateListCost('my-private-model', 1_000_000, 1_000_000), 0);
  assert.equal(estimateListCost('auto', 1_000_000, 1_000_000), 0);
  withDb(() => {
    // 老数据没有 requested_model：退回实际模型；实际模型也认不出 → 0
    localStats.record({
      provider_id: 'ollama', model: 'my-private-model', tier: 'free',
      input_tokens: 1_000_000, output_tokens: 1_000_000, data_source: 'proxy', billing_type: 'api-key',
    });
    const dash = localStats.queryDashboard(30);
    assert.equal(dash.routing_savings.calls, 1);
    assert.equal(dash.routing_savings.usd, 0);
  });
});
