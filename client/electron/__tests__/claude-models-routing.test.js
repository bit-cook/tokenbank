'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../local-gateway');
const { claudeOAuthModels } = require('../claude-models');
const config = { providers: [
  { id: 'claude-oauth-test', type: 'paid', source: 'subscription', enabled: true, auth_type: 'oauth', oauth_provider: 'claude', base_url: 'https://api.anthropic.com/v1', models: [] },
] };
after(() => gateway.stop());

test('all catalog models enter real route candidates when OAuth provider models are empty', () => {
  gateway.start(0, () => config, null);
  const candidates = gateway.buildStrategyCandidates('fallback', { provider: 'claude-oauth-test' }, '/v1/chat/completions', false, 'claude-catalog-test');
  assert.deepEqual(candidates.map((c) => c.model).sort(), claudeOAuthModels().map((m) => m.name).sort());
  assert.ok(candidates.every((c) => c.providerId === 'claude-oauth-test'));
  assert.deepEqual(config.providers[0].models, []);
});

test('disabled and explicitly narrowed OAuth providers are not broadened', () => {
  config.providers[0].models = [{ name: 'claude-sonnet-5', type: 'chat' }];
  let candidates = gateway.buildStrategyCandidates('fallback', {}, '/v1/chat/completions', false, 'claude-catalog-test');
  assert.deepEqual(candidates.map((c) => c.model), ['claude-sonnet-5']);
  config.providers[0].enabled = false;
  candidates = gateway.buildStrategyCandidates('fallback', {}, '/v1/chat/completions', false, 'claude-catalog-test');
  assert.deepEqual(candidates, []);
});
