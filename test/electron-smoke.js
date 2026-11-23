// Run with: npm run test:electron. All login responses are simulated locally.
const { app, BrowserWindow, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-electron-test-'));
app.setPath('userData', path.join(temp, 'user-data'));
const input = path.join(temp, 'accounts.txt');
const original = 'a@example.com|SecretA\nb@example.com|SecretB\nc@example.com|SecretC\nd@example.com|SecretD\ne@example.com|SecretE\nbad row\na@example.com|SecretA\n';
fs.writeFileSync(input, original);
let saveTarget;
const customOutput = path.join(temp, 'chosen output', 'results');
let cancelFolderPicker = false;
let openedOutput;
shell.openPath = async folder => { openedOutput = folder; return ''; };
dialog.showOpenDialog = async (_win, options) => options.properties.includes('openDirectory')
  ? { canceled: cancelFolderPicker, filePaths: cancelFolderPicker ? [] : [customOutput] }
  : { canceled: false, filePaths: [input] };
dialog.showSaveDialog = async (_win, options) => ({ canceled: false, filePath: saveTarget || options.defaultPath });
const pending = [];
const calls = [];
require.cache[require.resolve('../action')] = { exports: { checkLoginAppleID: (email, password, proxy) => {
  calls.push({ email, proxy });
  return new Promise((resolve, reject) => pending.push(() => {
    if (email.startsWith('e')) reject(new Error('simulated outage'));
    else resolve({ status: email.startsWith('b') ? 'invalid' : email.startsWith('c') ? 'unchecked' : 'valid', reason: email.startsWith('c') ? 'account_locked' : email.startsWith('b') ? 'incorrect_credentials' : 'authenticated' });
  }));
} } };
const waitFor = async (fn, message) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(`Timed out: ${message}`);
};
const watchdog = setTimeout(() => { console.error('Electron smoke test timed out'); app.exit(1); }, 40000);
app.once('browser-window-created', (_event, win) => {
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
    const snapshot = () => js('window.electronAPI.getState().then(r => r.value)');
    try {
      await waitFor(() => js('!document.getElementById("start").disabled'), 'initial IPC state');
      await click('choose-account');
      await waitFor(() => js(`document.getElementById('account-path').value === ${JSON.stringify(input)}`), 'file picker');
      const invalidOutput = await js(`window.electronAPI.start({accountPath: ${JSON.stringify(input)}, concurrency: 2, outputFolder: ${JSON.stringify(input)}})`);
      assert.equal(invalidOutput.ok, false);
      assert.equal(calls.length, 0);
      assert.equal(fs.readFileSync(input, 'utf8'), original);
      await click('choose-output');
      await waitFor(() => js(`document.getElementById('output-folder').value === ${JSON.stringify(customOutput)}`), 'folder picker');
      assert.equal(await js('JSON.parse(localStorage.getItem("apple-checker-inputs")).outputFolder'), customOutput);
      cancelFolderPicker = true;
      await click('choose-output');
      await waitFor(() => js('!document.getElementById("start").disabled'), 'cancel folder picker');
      assert.equal(await js('document.getElementById("output-folder").value'), customOutput);
      cancelFolderPicker = false;
      const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
      win.webContents.reload();
      await reloaded;
      await waitFor(() => js('!document.getElementById("start").disabled'), 'restored preferences');
      assert.equal(await js('document.getElementById("output-folder").value'), customOutput);
      assert.equal(await js('document.getElementById("account-path").value'), input);
      await js('document.getElementById("concurrency").value = 2');
      await click('start');
      await waitFor(() => calls.length === 2, 'worker allocation');
      assert.equal((await snapshot()).active, 2);
      assert.equal((await snapshot()).total, 6);
      assert.equal(await js('document.getElementById("account-path").disabled'), true);
      assert.equal(await js('document.getElementById("output-folder").disabled'), true);
      assert.equal(await js('document.getElementById("choose-output").disabled'), true);
      assert.equal((await snapshot()).outputRoot, customOutput);
      assert.equal(path.dirname((await snapshot()).outputDir), customOutput);
      assert.equal((await js('window.electronAPI.chooseOutputFolder()')).ok, false);
      const duplicateStart = await js('window.electronAPI.start({})');
      assert.equal(duplicateStart.ok, false);
      assert.equal((await js('window.electronAPI.reset()')).ok, false);
      await click('pause');
      await waitFor(async () => (await snapshot()).status === 'pausing', 'pause transition');
      pending.splice(0).forEach(resolve => resolve());
      await waitFor(async () => (await snapshot()).status === 'paused', 'pause drains requests');
      assert.equal(calls.length, 2);
      assert.equal((await snapshot()).processed, 2);
      await click('start');
      await waitFor(() => pending.length === 2, 'resume');
      while ((await snapshot()).status !== 'completed') {
        pending.splice(0).forEach(resolve => resolve());
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const final = await snapshot();
      assert.equal(final.processed, 6);
      assert.equal(final.valid, 2); assert.equal(final.invalid, 1); assert.equal(final.unchecked, 3);
      assert.equal(final.active, 0); assert.equal(final.duplicates, 1);
      assert.equal(calls.length, 5);
      assert.equal(new Set(calls.map(x => x.email)).size, 5);
      assert.equal(await js('document.body.innerText.includes("Secret")'), false);
      assert.equal(await js('document.getElementById("processed").textContent'), '6');
      assert.equal(await js('document.getElementById("progress").value'), 100);
      assert.equal(fs.readFileSync(input, 'utf8'), original);
      const expectedOutputs = { valid: ['a@example.com|SecretA', 'd@example.com|SecretD'], invalid: ['b@example.com|SecretB'], unchecked: ['c@example.com|SecretC', 'e@example.com|SecretE', 'bad row'] };
      for (const [status, lines] of Object.entries(expectedOutputs)) {
        const actual = fs.readFileSync(path.join(final.outputDir, `${status}.txt`), 'utf8').split('\n').filter(Boolean).sort();
        assert.deepEqual(actual, [...lines].sort());
      }
      await click('open-results');
      await waitFor(() => openedOutput === final.outputDir, 'open selected output');
      await waitFor(() => js('!document.getElementById("export-pending").disabled'), 'open folder command completed');
      await click('export-pending');
      await waitFor(() => fs.existsSync(path.join(final.outputDir, 'pending.txt')), 'pending export');
      assert.equal(fs.readFileSync(path.join(final.outputDir, 'pending.txt'), 'utf8').trim().split('\n').length, 3);
      saveTarget = input;
      const overwrite = await js('window.electronAPI.exportPending()');
      assert.equal(overwrite.ok, false);
      assert.equal(fs.readFileSync(input, 'utf8'), original);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 150));
      const screenshot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(temp, 'ui-completed.png'), screenshot.toPNG());
      const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), sandbox: true, contextIsolation: true } });
      await other.loadURL('data:text/html,<p>Untrusted window</p>');
      assert.equal((await other.webContents.executeJavaScript('window.electronAPI.getState()')).ok, false);
      other.destroy();
      await click('reset');
      await waitFor(() => js('!document.getElementById("account-path").disabled'), 'reset unlocks inputs');
      assert.equal(await js('document.getElementById("choose-output").disabled'), false);
      await js('document.getElementById("output-folder").value = ""');
      await click('start');
      await waitFor(() => pending.length === 2, 'new session');
      assert.equal((await snapshot()).outputRoot, path.join(app.getPath('userData'), 'AppleIDResults'));
      assert.notEqual((await snapshot()).outputDir, final.outputDir);
      win.close(); win.close();
      assert.equal(win.isDestroyed(), false, 'repeated close must wait for requests');
      pending.splice(0).forEach(resolve => resolve());
      await waitFor(() => win.isDestroyed(), 'graceful close');
      assert.deepEqual(errors, []);
      clearTimeout(watchdog);
      console.log('PASS Electron UI/IPC: start, duplicate start, pause/resume, counters, custom/default output, folder cancellation/persistence, export protection, untrusted sender, reset, repeated close');
      console.log(`Smoke artifacts: ${temp}`);
      app.exit(0);
    } catch (error) {
      clearTimeout(watchdog);
      console.error(error.stack);
      console.error('Renderer errors:', errors);
      console.error(`Smoke artifacts: ${temp}`);
      app.exit(1);
    }
  });
});
require('../main');
