'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const oauth = require('../oauth');

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const PREFIX = 'x-anthropic-billing-header:';
const OLD = `${PREFIX} cc_version=0.0.1.abc; cc_entrypoint=sdk-cli; cch=00000;`;
function apply(body, headers = {}) {
  return oauth.applyAuth('claude', { body, headers, credentials: { access_token: 'test-token' } });
}
function assertLayout(result) {
  assert.equal(result.body.system[0].type, 'text');
  assert.match(result.body.system[0].text, /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[a-f0-9]{3}; cc_entrypoint=cli;$/);
  assert.equal(result.body.system[1].text, IDENTITY);
  assert.equal(result.body.system[0].cache_control, undefined);
  assert.equal(result.body.system[1].cache_control, undefined);
  assert.equal(Object.keys(result.headers).some((key) => key.toLowerCase() === 'x-anthropic-billing-header'), false);
}

test('OAuth adds billing before identity and preserves request fields without mutation', () => {
  const body = { model: 'claude-test', system: 'Keep my instructions.', messages: [{ role: 'user', content: '0123456789abcdefghijklmnopqrstuvwxyz' }], stream: true, tools: [{ name: 'test' }] };
  const original = structuredClone(body);
  const out = apply(body, { 'x-api-key': 'obsolete' });
  assertLayout(out);
  assert.equal(out.body.system[0].text, `${PREFIX} cc_version=2.1.161.d6d; cc_entrypoint=cli;`);
  assert.equal(out.body.system[2].text, body.system);
  assert.deepEqual(out.body.messages, body.messages);
  assert.deepEqual(out.body.tools, body.tools);
  assert.equal(out.body.stream, true);
  assert.equal(out.headers.Authorization, 'Bearer test-token');
  assert.equal(out.headers['x-api-key'], undefined);
  assert.equal(out.baseUrl, 'https://api.anthropic.com');
  assert.deepEqual(body, original);
});

test('replaces duplicate billing blocks and keeps original cache breakpoints', () => {
  const prompt = { type: 'text', text: 'Original prompt', cache_control: { type: 'ephemeral' } };
  const body = { system: [{ type: 'text', text: OLD, cache_control: { type: 'ephemeral' } }, { type: 'text', text: IDENTITY }, OLD, prompt], messages: [] };
  const original = structuredClone(body);
  const first = apply(body);
  const second = apply(first.body);
  assertLayout(first);
  assert.deepEqual(first.body.system, [first.body.system[0], first.body.system[1], prompt]);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(body, original);
});

test('string and array blocks keep instructions after a leading billing line', () => {
  for (const system of [OLD + '\r\nKeep this.', [{ type: 'text', text: OLD + '\nKeep this.', cache_control: { type: 'ephemeral' } }]]) {
    const out = apply({ system, messages: [] });
    assertLayout(out);
    assert.equal(out.body.system[2].text, 'Keep this.');
    if (Array.isArray(system)) assert.deepEqual(out.body.system[2].cache_control, { type: 'ephemeral' });
  }
  const literal = `Keep this literal inside the prompt:\n${OLD}`;
  assert.equal(apply({ system: literal }).body.system[2].text, literal);
});

test('missing, short and non-text first user content use deterministic padding', () => {
  for (const messages of [undefined, [], [{ role: 'user', content: 'Hi' }], [{ role: 'user', content: [{ type: 'image', source: {} }] }, { role: 'user', content: 'Do not sample the second user' }]]) {
    const out = apply({ messages });
    assertLayout(out);
    assert.equal(out.body.system[0].text, `${PREFIX} cc_version=2.1.161.b76; cc_entrypoint=cli;`);
  }
});

test('string and text-block inputs use the same first-user fingerprint', () => {
  const text = '0123456789abcdefghijklmnopqrstuvwxyz';
  const billing = (content) => apply({ messages: [{ role: 'assistant', content: 'ignore' }, { role: 'user', content }] }).body.system[0].text;
  assert.equal(billing(text), billing([{ type: 'image', source: {} }, { type: 'text', text }, { type: 'text', text: 'ignore' }]));
  assert.notEqual(billing(text), billing('0123X6789abcdefghijklmnopqrstuvwxyz'));
});

test('UTF-8 sample matches the sub2api byte-index convention', () => {
  const out = apply({ messages: [{ role: 'user', content: '你好世界，这是中文测试消息。' }] });
  assert.equal(out.body.system[0].text, `${PREFIX} cc_version=2.1.161.7c3; cc_entrypoint=cli;`);
});

test('billing version follows an overridden outbound CLI User-Agent', () => {
  for (const key of ['User-Agent', 'user-agent']) {
    const out = apply({ messages: [] }, { [key]: 'claude-cli/2.1.200 (external, cli)' });
    assertLayout(out);
    assert.match(out.body.system[0].text, /cc_version=2\.1\.200\.[a-f0-9]{3};/);
  }
});

test('non-OAuth preparation does not inject Claude system blocks', async () => {
  const provider = { id: 'anthropic-api', auth_type: 'api_key' };
  assert.equal(await oauth.prepare(provider), provider);
});
