const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function cleanPath(value) {
  const text = String(value || '').trim();
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function parseAccounts(text) {
  const seen = new Set();
  let duplicates = 0;
  const rows = [];
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const separator = raw.indexOf('|');
    const email = (separator < 0 ? raw : raw.slice(0, separator)).trim();
    const password = separator < 0 ? '' : raw.slice(separator + 1);
    const valid = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email) && password.length > 0;
    const line = valid ? `${email}|${password}` : raw;
    if (seen.has(line)) { duplicates++; continue; }
    seen.add(line);
    rows.push({ line, email, password, valid, lineNumber: index + 1, state: 'pending' });
  }
  return { rows, duplicates };
}

function parseProxies(text) {
  return [...new Set(text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean))].map(proxy => {
    const parts = proxy.split(':');
    if (![2, 4].includes(parts.length) || !parts[0] || /[\s/]/.test(parts[0]) ||
        !/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > 65535 ||
        (parts.length === 4 && (!parts[2] || !parts[3]))) {
      throw new Error('Proxy không hợp lệ. Dùng host:port hoặc host:port:user:pass.');
    }
    return proxy;
  });
}

function loadInputs(config) {
  const accountPath = cleanPath(config.accountPath);
  const proxyPath = cleanPath(config.proxyPath);
  const concurrency = Number(config.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) throw new Error('Số luồng phải là số nguyên từ 1 đến 200.');
  if (!accountPath || !fs.statSync(accountPath).isFile()) throw new Error('Hãy chọn file Apple ID hợp lệ.');
  const parsed = parseAccounts(fs.readFileSync(accountPath, 'utf8'));
  if (!parsed.rows.length) throw new Error('File Apple ID không có dữ liệu.');
  let proxies = [];
  if (proxyPath) {
    if (!fs.statSync(proxyPath).isFile()) throw new Error('Hãy chọn file proxy hợp lệ.');
    proxies = parseProxies(fs.readFileSync(proxyPath, 'utf8'));
    if (!proxies.length) throw new Error('File proxy trống. Bỏ đường dẫn proxy nếu muốn kết nối trực tiếp.');
  }
  return { ...parsed, accountPath: path.resolve(accountPath), proxyPath, concurrency, proxies };
}

class JobRunner extends EventEmitter {
  constructor({ rows, duplicates = 0, concurrency, proxies = [], accountPath, proxyPath = '', outputRoot, check }) {
    super();
    Object.assign(this, { rows, duplicates, concurrency, proxies, accountPath, proxyPath, check });
    this.status = 'ready';
    this.cursor = 0;
    this.active = 0;
    this.counts = { valid: 0, invalid: 0, unchecked: 0 };
    this.elapsedMs = 0;
    this.startedAt = 0;
    this.recent = [];
    this.error = '';
    fs.mkdirSync(outputRoot, { recursive: true });
    this.outputDir = fs.mkdtempSync(path.join(outputRoot, 'run-'));
    for (const status of Object.keys(this.counts)) fs.writeFileSync(path.join(this.outputDir, `${status}.txt`), '', { mode: 0o600 });
  }

  snapshot() {
    const processed = this.counts.valid + this.counts.invalid + this.counts.unchecked;
    return {
      status: this.status, total: this.rows.length, processed, ...this.counts,
      pending: this.rows.length - processed - this.active, active: this.active,
      duplicates: this.duplicates, concurrency: this.concurrency,
      elapsedSeconds: Math.floor((this.elapsedMs + (this.startedAt ? Date.now() - this.startedAt : 0)) / 1000),
      outputDir: this.outputDir, recent: this.recent, error: this.error
    };
  }

  update() { this.emit('update', this.snapshot()); }

  pause() {
    if (this.status === 'running') { this.status = 'pausing'; this.update(); }
    return this.snapshot();
  }

  async run() {
    if (!['ready', 'paused', 'failed'].includes(this.status)) throw new Error('Phiên đang chạy hoặc đã hoàn tất.');
    this.status = 'running';
    this.error = '';
    this.cursor = 0;
    this.startedAt = Date.now();
    this.update();
    const timer = setInterval(() => this.update(), 1000);
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, this.rows.length) }, () => this.worker()));
    } finally {
      clearInterval(timer);
      this.elapsedMs += Date.now() - this.startedAt;
      this.startedAt = 0;
      if (this.status !== 'failed') this.status = this.rows.every(row => row.state === 'done') ? 'completed' : 'paused';
      this.update();
    }
    return this.snapshot();
  }

  async worker() {
    while (this.status === 'running') {
      while (this.cursor < this.rows.length && this.rows[this.cursor].state !== 'pending') this.cursor++;
      if (this.cursor >= this.rows.length) return;
      const index = this.cursor++;
      const row = this.rows[index];
      row.state = 'running';
      this.active++;
      this.update();
      let result;
      try {
        result = row.valid
          ? await this.check(row.email, row.password, this.proxies.length ? this.proxies[index % this.proxies.length] : null, {
            retryState: row.retryState ||= {}, shouldRetry: () => this.status === 'running'
          })
          : { status: 'unchecked', reason: 'invalid_input' };
        if (!Object.hasOwn(this.counts, result?.status)) result = { status: 'unchecked', reason: 'unknown_response' };
      } catch {
        result = { status: 'unchecked', reason: 'request_failed' };
      }
      if (result.deferred) {
        row.state = 'pending';
        this.active--;
        this.update();
        continue;
      }
      try {
        const reason = String(result.reason || '').replace(/[\r\n|]/g, ' ');
        fs.appendFileSync(path.join(this.outputDir, `${result.status}.txt`), `${row.line}|${result.status}|${reason}\n`);
        row.state = 'done';
        row.result = result.status;
        this.counts[result.status]++;
        this.recent.unshift({ lineNumber: row.lineNumber, email: row.email, status: result.status, reason });
        this.recent = this.recent.slice(0, 100);
      } catch {
        row.state = 'pending';
        this.status = 'failed';
        this.error = 'Không ghi được kết quả. Kiểm tra dung lượng/quyền thư mục rồi nhấn Tiếp tục; dòng chưa lưu được giữ lại.';
      } finally {
        this.active--;
        this.update();
      }
    }
  }

  pendingLines() {
    return this.rows.filter(row => row.state !== 'done' || row.result === 'unchecked').map(row => row.line);
  }
}

module.exports = { JobRunner, loadInputs, parseAccounts, parseProxies, cleanPath };
