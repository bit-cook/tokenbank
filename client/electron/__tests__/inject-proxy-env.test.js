'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseScutilProxy,
  parseWinProxyServer,
  hasProxyEnv,
  injectProxyEnv,
  resolveOutboundProxyUrl,
  chromiumProxySettings,
} = require('../../shared/inject-proxy-env');

test('parseScutilProxy: HTTPS 优先', () => {
  assert.equal(parseScutilProxy(`
HTTPEnable : 1
HTTPPort : 7890
HTTPProxy : 127.0.0.1
HTTPSEnable : 1
HTTPSPort : 7890
HTTPSProxy : 127.0.0.1
`), 'http://127.0.0.1:7890');
});

test('parseWinProxyServer', () => {
  assert.equal(parseWinProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWinProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('injectProxyEnv: 已有环境变量时不覆盖', () => {
  const prev = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://already:1';
  assert.equal(hasProxyEnv(), true);
  assert.equal(injectProxyEnv(), null);
  if (prev === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = prev;
});

test('chromiumProxySettings: 有 HTTPS_PROXY 时走 fixed proxyRules', () => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  try {
    assert.equal(resolveOutboundProxyUrl(), 'http://127.0.0.1:7890');
    const cfg = chromiumProxySettings();
    assert.equal(cfg.proxyRules, 'http://127.0.0.1:7890');
    assert.match(cfg.proxyBypassRules, /localhost/);
    assert.equal(cfg.mode, undefined);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});
