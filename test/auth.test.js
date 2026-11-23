const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
      return dependencies[name];
    }, setTimeout, clearTimeout, console, ...globals
  }, { filename: file });
  return module.exports;
}

function mockAuth(status = 200, hang = false, failure = null) {
  const calls = [];
  let active = 0;
  const instance = { request: async config => {
    calls.push(config);
    if (hang) {
      active++;
      try { await new Promise((resolve, reject) => config.cancelToken.subscribe(() => reject(new Error('cancelled')))); }
      finally { active--; }
    }
    if (failure && (!failure.stage || config.url.includes(failure.stage))) throw failure.error;
    if (config.url.includes('/authorize/')) return { data: '<html></html>' };
    if (config.url.endsWith('/init')) return { data: { protocol: 's2k' } };
    if (status !== 200) throw { response: { status, headers: { 'set-cookie': [] } } };
    return { data: {}, headers: { 'set-cookie': [] } };
  } };
  const axios = {
    create: () => instance,
    CancelToken: { source: () => {
      const subscribers = [];
      return { token: { subscribe: callback => subscribers.push(callback) }, cancel: () => subscribers.forEach(fn => fn()) };
    } }
  };
  const cheerio = { load: () => selector => selector === '.boot_args'
    ? { each: fn => fn(0, {}) }
    : { text: () => JSON.stringify({ direct: { appleOAuth: { requestor: { id: 'test-widget' } } } }) }
  };
  const auth = loadModule('ipv4.js', {
    cheerio, 'axios-https-proxy-fix': axios,
    './GSASRPAuthenticator': { GSASRPAuthenticator: class {
      async getInit() { return { a: 'test' }; }
      async getComplete() { return { m1: 'test', m2: 'test' }; }
    } }
  });
  return { ...auth, calls, active: () => active };
}

test('CHBM contract maps successful/challenge/invalid/locked/service responses without treating outages as bad passwords', async () => {
  const cases = [[200, 'checked', 'successfully'], [409, 'checked', 'CHBM'], [401, 'checked', 'sai pass'], [403, 'checked', 'locked'], [412, 'checked', 'successfully'], [503, 'not checked', undefined], [429, 'not checked', undefined]];
  for (const [status, expected, note] of cases) {
    const auth = mockAuth(status);
    const result = await auth.CHBMAppleID('a@example.com', 'password', 'host:80:user:secret');
    assert.equal(result.status, expected, String(status));
    assert.equal(result.note, note, String(status));
    assert.equal(auth.calls.length, 3);
    assert.equal(auth.calls[0].proxy.host, 'host');
    assert.equal(auth.calls[0].proxy.auth.username, 'user');
    assert.ok(auth.calls.every(call => call.cancelToken));
    assert.ok(auth.calls.every(call => !call.url.includes('/repair')));
  }
});

test('optional direct connection and malformed proxies return without hanging', async () => {
  const auth = mockAuth();
  const direct = await auth.CHBMAppleID('a@example.com', 'password', null);
  assert.equal(direct.status, 'checked');
  assert.equal(auth.calls[0].proxy, false);
  for (const proxy of ['host:0', 'host:99999', 'host:abc', 'host:80:user', 'host:80::pass']) {
    assert.equal((await auth.CHBMAppleID('a@example.com', 'p', proxy)).status, 'not checked');
  }
});

test('deadline cancels the underlying HTTP request and leaves no running request', async () => {
  const auth = mockAuth(200, true);
  const result = await auth.CHBMAppleID('a@example.com', 'p', null, { timeoutMs: 10 });
  assert.equal(result.status, 'not checked');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(auth.active(), 0);
  assert.equal(auth.calls.length, 1);
});

test('adapter classifies only known outcomes and forwards arguments to CHBMAppleID', async () => {
  let response;
  let args;
  const action = loadModule('action.js', { './ipv4': { CHBMAppleID: async (...values) => { args = values; return response; } } });
  for (const [note, status] of [['successfully', 'valid'], ['CHBM', 'valid'], ['sai pass', 'invalid'], ['locked', 'unchecked'], ['unknown', 'unchecked']]) {
    response = { status: 'checked', note };
    assert.equal((await action.checkLoginAppleID('a@example.com', 'pass', 'host:80')).status, status);
    assert.deepEqual(args, ['a@example.com', 'pass', 'host:80']);
  }
  response = { status: 'not checked', note: 'sai pass' };
  assert.equal((await action.checkLoginAppleID('a@example.com', 'pass')).status, 'unchecked');
  assert.equal(args[2], null);
});

test('temporary request errors at every auth stage remain distinguishable from unknown responses', async () => {
  const failures = [
    [{ code: 'ECONNRESET' }, 'network_error'],
    [{ code: 'ENOTFOUND' }, 'network_error'],
    [{ request: {} }, 'network_error'],
    [{ code: 'ECONNABORTED' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ response: { status: 407 } }, 'proxy_error'],
    [{ response: { status: 503 } }, 'service_unavailable']
  ];
  for (const stage of ['/authorize/', '/init', '/complete']) {
    for (const [error, reason] of failures) {
      const auth = mockAuth(200, false, { error, stage });
      const result = await auth.CHBMAppleID('a@example.com', 'p', null);
      assert.equal(result.status, 'not checked');
      assert.equal(result.reason, reason);
      assert.equal(result.retryable, true);
    }
  }
  for (const error of [new SyntaxError('bad response'), { response: { status: 429 } }, { response: { status: 400 } }]) {
    const result = await mockAuth(200, false, { error }).CHBMAppleID('a@example.com', 'p', null);
    assert.equal(result.retryable, false);
    assert.equal(result.reason, 'unknown_response');
  }
});

function retryAdapter(check, delays = []) {
  return loadModule('action.js', { './ipv4': { CHBMAppleID: check } }, {
    setTimeout: (callback, ms) => { delays.push(ms); return setTimeout(callback, 0); }
  });
}

test('retry succeeds on fourth call, waits 1/2/3 seconds, and keeps the same account and proxy', async () => {
  const delays = [], calls = [];
  const outcomes = ['network_error', 'timeout', 'service_unavailable'];
  const action = retryAdapter(async (...args) => {
    calls.push(args);
    return calls.length <= 3
      ? { status: 'not checked', reason: outcomes[calls.length - 1], retryable: true }
      : { status: 'checked', note: 'successfully' };
  }, delays);
  const result = await action.checkLoginAppleID('a@example.com', 'pass', 'host:80');
  assert.equal(result.status, 'valid');
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [1000, 2000, 3000]);
  assert.ok(calls.every(args => args[0] === 'a@example.com' && args[1] === 'pass' && args[2] === 'host:80'));
});

test('persistent network/proxy/timeout/503 failures stop after three retries; exhausted state cannot reset the budget', async () => {
  for (const reason of ['network_error', 'proxy_error', 'timeout', 'service_unavailable']) {
    let calls = 0;
    const action = retryAdapter(async () => { calls++; return { status: 'not checked', reason, retryable: true }; });
    const retryState = {};
    const result = await action.checkLoginAppleID('a@example.com', 'pass', null, { retryState });
    assert.equal(calls, 4);
    assert.equal(result.status, 'unchecked');
    assert.equal(result.reason, reason);
    assert.equal(result.deferred, undefined);
    await action.checkLoginAppleID('a@example.com', 'pass', null, { retryState });
    assert.equal(calls, 4);
  }
});

test('invalid credentials, locked accounts, invalid proxy and unknown responses are never retried', async () => {
  for (const response of [
    { status: 'checked', note: 'sai pass' }, { status: 'checked', note: 'locked' },
    { status: 'checked', note: 'unexpected' }, { status: 'not checked', note: 'invalid proxy' },
    { status: 'not checked', reason: 'unknown_response', retryable: false }
  ]) {
    let calls = 0;
    const delays = [];
    const action = retryAdapter(async () => { calls++; return response; }, delays);
    await action.checkLoginAppleID('a@example.com', 'pass', null);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test('pause defers retries without consuming an attempt and resume preserves the retry budget', async () => {
  let calls = 0, running = false;
  const retryState = {};
  const action = retryAdapter(async () => {
    calls++;
    return { status: 'not checked', reason: 'timeout', retryable: true };
  });
  const options = { retryState, shouldRetry: () => running };
  const first = await action.checkLoginAppleID('a@example.com', 'pass', null, options);
  assert.equal(first.deferred, true);
  assert.equal(calls, 1);
  assert.equal(retryState.attempts, 1);
  running = true;
  const final = await action.checkLoginAppleID('a@example.com', 'pass', null, options);
  assert.equal(final.status, 'unchecked');
  assert.equal(final.deferred, undefined);
  assert.equal(calls, 4);
});

test('pause during backoff prevents the next HTTP attempt', async () => {
  let calls = 0, running = true;
  const action = loadModule('action.js', { './ipv4': { CHBMAppleID: async () => {
    calls++; return { status: 'not checked', reason: 'network_error', retryable: true };
  } } }, { setTimeout: callback => { running = false; return setTimeout(callback, 0); } });
  const result = await action.checkLoginAppleID('a@example.com', 'pass', null, { shouldRetry: () => running });
  assert.equal(result.deferred, true);
  assert.equal(calls, 1);
});
