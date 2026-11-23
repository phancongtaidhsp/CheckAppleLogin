const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobRunner, loadInputs, parseAccounts, parseProxies, cleanPath } = require('../job-runner');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new JobRunner({ ...parseAccounts(Array.from({ length: 7 }, (_, i) => `account${i}@example.com|Password${i}`).join('\n')), concurrency: 3, accountPath: path.join(dir, 'input.txt'), outputRoot: dir, check: async () => ({ status: 'valid' }), ...options });
}

test('input parsing preserves password delimiters/whitespace, BOM, CRLF, malformed rows and exact deduplication', () => {
  const parsed = parseAccounts('\uFEFFa@example.com| p|ss \r\n\r\na@example.com| p|ss \r\na@example.com|other\r\nbad\r\nempty@example.com|');
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[0].password, ' p|ss ');
  assert.equal(parsed.rows[0].lineNumber, 1);
  assert.equal(parsed.rows[1].valid, true);
  assert.equal(parsed.rows[2].valid, false);
  assert.equal(parsed.rows[3].valid, false);
  assert.equal(cleanPath(' "path with space" '), 'path with space');
});

test('proxy validation handles empty/duplicate lines and rejects malformed ports and credentials', () => {
  assert.deepEqual(parseProxies('\uFEFFhost:80\r\nhost:80\nserver:8080:user:pass\n'), ['host:80', 'server:8080:user:pass']);
  assert.deepEqual(parseProxies(' \n'), []);
  for (const value of ['host:0', 'host:65536', 'host:abc', 'http://host:80', 'host:80:user', 'host:80::pass', 'host:80:user:']) assert.throws(() => parseProxies(value));
});

test('file validation rejects bad concurrency and blank files; quoted input path and optional proxy work', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-input-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.txt');
  fs.writeFileSync(file, 'a@example.com|p');
  const config = { accountPath: `"${file}"`, concurrency: '3', proxyPath: '' };
  assert.equal(loadInputs(config).rows.length, 1);
  assert.deepEqual(loadInputs(config).proxies, []);
  for (const concurrency of [1, 50, 200]) assert.equal(loadInputs({ ...config, concurrency }).concurrency, concurrency);
  for (const concurrency of [0, -1, 1.5, 201, 'abc', '']) assert.throws(() => loadInputs({ ...config, concurrency }));
  assert.throws(() => loadInputs({ ...config, proxyPath: '/nonexistent/proxy.txt' }));
  fs.writeFileSync(file, '\r\n');
  assert.throws(() => loadInputs(config), /không có dữ liệu/);
});

test('concurrency is bounded; end-of-input waits for in-flight tasks; pause drains and resume never duplicates', async t => {
  const waiting = [];
  const calls = [];
  let active = 0, peak = 0;
  const job = fixture(t, { check: async email => {
    calls.push(email); active++; peak = Math.max(peak, active);
    await new Promise(resolve => waiting.push(resolve)); active--;
    return { status: 'valid', reason: 'authenticated' };
  } });
  const first = job.run();
  assert.equal(job.snapshot().active, 3);
  assert.equal(job.snapshot().status, 'running');
  await assert.rejects(job.run());
  job.pause();
  assert.equal(job.snapshot().status, 'pausing');
  waiting.splice(0).forEach(resolve => resolve());
  await first;
  assert.equal(job.status, 'paused');
  assert.equal(job.snapshot().processed, 3);
  assert.equal(calls.length, 3);
  const second = job.run();
  assert.equal(job.snapshot().active, 3);
  waiting.splice(0).forEach(resolve => resolve());
  await tick();
  assert.equal(job.snapshot().status, 'running');
  assert.equal(job.snapshot().active, 1);
  assert.equal(job.snapshot().processed, 6);
  waiting.splice(0).forEach(resolve => resolve());
  await second;
  assert.equal(job.status, 'completed');
  assert.equal(peak, 3);
  assert.equal(new Set(calls).size, 7);
  assert.equal(job.snapshot().processed, 7);
  assert.equal(fs.readFileSync(path.join(job.outputDir, 'valid.txt'), 'utf8').trim().split('\n').length, 7);
  assert.deepEqual(job.pendingLines(), []);
  assert.ok(!JSON.stringify(job.snapshot()).includes('Password'));
});

test('exceptions and malformed input become unchecked; all outputs are separate and original input is untouched', async t => {
  const job = fixture(t, { ...parseAccounts('a@example.com|one\nb@example.com|two\nbad\nc@example.com|three'), concurrency: 2,
    check: async email => { if (email.startsWith('c')) throw new Error('network'); return { status: email.startsWith('a') ? 'valid' : 'invalid' }; }
  });
  fs.writeFileSync(job.accountPath, 'original');
  await job.run();
  assert.equal(job.counts.valid, 1); assert.equal(job.counts.invalid, 1); assert.equal(job.counts.unchecked, 2);
  assert.equal(fs.readFileSync(job.accountPath, 'utf8'), 'original');
  assert.deepEqual(job.pendingLines(), ['bad', 'c@example.com|three']);
  for (const status of ['valid', 'invalid', 'unchecked']) assert.ok(fs.readFileSync(path.join(job.outputDir, `${status}.txt`), 'utf8').includes(`|${status}|`));
});

test('write failure stops allocation and retains unsaved rows for resume', async t => {
  const job = fixture(t, { concurrency: 1 });
  const output = path.join(job.outputDir, 'valid.txt');
  fs.unlinkSync(output); fs.mkdirSync(output);
  await job.run();
  assert.equal(job.status, 'failed');
  assert.equal(job.snapshot().processed, 0);
  assert.equal(job.pendingLines().length, 7);
  fs.rmdirSync(output); fs.writeFileSync(output, '');
  await job.run();
  assert.equal(job.status, 'completed');
  assert.equal(job.snapshot().processed, 7);
});

test('new sessions have isolated files; fewer rows than workers and unknown checker values complete correctly', async t => {
  const first = fixture(t, { ...parseAccounts('a@example.com|p'), concurrency: 200, check: async () => undefined });
  const second = fixture(t, { outputRoot: path.dirname(first.outputDir) });
  assert.notEqual(first.outputDir, second.outputDir);
  await first.run();
  assert.equal(first.status, 'completed');
  assert.equal(first.snapshot().unchecked, 1);
  assert.equal(first.snapshot().active, 0);
});

test('retrying rows stay in their worker, pause saves no intermediate result, and resume preserves attempts', async t => {
  const vm = require('node:vm');
  const pending = [], calls = new Map();
  let active = 0, peak = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'action.js'), 'utf8'), {
    module, exports: module.exports,
    require: () => ({ CHBMAppleID: async email => {
      calls.set(email, (calls.get(email) || 0) + 1);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => pending.push(resolve));
      active--;
      return email.startsWith('a') && calls.get(email) > 1
        ? { status: 'checked', note: 'successfully' }
        : { status: 'not checked', reason: 'service_unavailable', retryable: true };
    } }),
    setTimeout: callback => setTimeout(callback, 0)
  });
  const job = fixture(t, { ...parseAccounts('a@example.com|pass\nb@example.com|pass'), concurrency: 2, check: module.exports.checkLoginAppleID });
  const first = job.run();
  assert.equal(pending.length, 2);
  job.pause();
  pending.splice(0).forEach(resolve => resolve());
  await first;
  assert.equal(job.status, 'paused');
  assert.equal(job.snapshot().processed, 0);
  assert.equal(job.snapshot().pending, 2);
  assert.equal(fs.readFileSync(path.join(job.outputDir, 'unchecked.txt'), 'utf8'), '');
  assert.deepEqual(job.rows.map(row => row.retryState.attempts), [1, 1]);
  const resumed = job.run();
  for (let turn = 0; turn < 100 && job.status === 'running'; turn++) {
    pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(job.status, 'completed');
  await resumed;
  assert.equal(calls.get('a@example.com'), 2);
  assert.equal(calls.get('b@example.com'), 4);
  assert.equal(peak, 2);
  assert.equal(job.snapshot().processed, 2);
  assert.equal(job.snapshot().valid, 1);
  assert.equal(job.snapshot().unchecked, 1);
  for (const status of ['valid', 'unchecked']) assert.equal(fs.readFileSync(path.join(job.outputDir, `${status}.txt`), 'utf8').trim().split('\n').length, 1);
});
