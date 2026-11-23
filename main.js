const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { JobRunner, loadInputs, cleanPath } = require('./job-runner');
const { checkLoginAppleID } = require('./action');

let win;
let runner;
let runPromise;
let closing = false;
let quitRequested = false;
const isBusy = () => !!runPromise;
const publish = snapshot => {
  if (win && !win.isDestroyed()) win.webContents.send('run-state', snapshot);
};

function launch() {
  runPromise = runner.run().catch(() => {
    runner.status = 'failed';
    runner.error = 'Phiên chạy gặp lỗi. Kết quả đã ghi được giữ nguyên.';
  }).finally(() => { runPromise = null; publish(runner.snapshot()); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 840, minWidth: 850, minHeight: 650,
    title: 'Apple ID Login Checker',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => {
    if (!isBusy()) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    runner.pause();
    publish({ ...runner.snapshot(), error: 'Đang chờ tác vụ hiện tại kết thúc trước khi đóng…' });
    runPromise.finally(() => { if (!win.isDestroyed()) win.close(); });
  });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: 'Yêu cầu không hợp lệ.' };
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.code ? `Không truy cập được file/thư mục (${error.code}).` : error.message }; }
  });
}

handle('get-state', () => runner?.snapshot() || null);
handle('choose-file', async kind => {
  if (isBusy() || runner) throw new Error('Bấm Phiên mới trước khi đổi dữ liệu.');
  if (!['account', 'proxy'].includes(kind)) throw new Error('Loại file không hợp lệ.');
  const result = await dialog.showOpenDialog(win, {
    title: kind === 'account' ? 'Chọn file Apple ID (email|password)' : 'Chọn file proxy',
    properties: ['openFile'], filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
handle('choose-output-folder', async currentPath => {
  if (isBusy() || runner) throw new Error('Bấm Phiên mới trước khi đổi thư mục kết quả.');
  const result = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục output',
    defaultPath: cleanPath(currentPath) || path.join(app.getPath('userData'), 'AppleIDResults'),
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});
handle('start', config => {
  if (isBusy() || closing) throw new Error('Vui lòng chờ phiên hiện tại kết thúc hoặc tạm dừng xong.');
  if (runner && ['paused', 'failed'].includes(runner.status)) {
    launch();
    return runner.snapshot();
  }
  if (runner) throw new Error('Bấm Phiên mới để chạy dữ liệu mới.');
  const inputs = loadInputs(config || {});
  const outputRoot = cleanPath(config?.outputFolder) || path.join(app.getPath('userData'), 'AppleIDResults');
  runner = new JobRunner({ ...inputs, outputRoot, check: checkLoginAppleID });
  runner.on('update', publish);
  launch();
  return runner.snapshot();
});
handle('pause', () => runner?.pause() || null);
handle('reset', () => {
  if (isBusy()) throw new Error('Hãy tạm dừng và chờ các tác vụ đang chạy kết thúc.');
  runner?.removeAllListeners();
  runner = null;
  publish(null);
  return null;
});
handle('open-results', async () => {
  if (!runner) throw new Error('Chưa có phiên chạy.');
  const error = await shell.openPath(runner.outputDir);
  if (error) throw new Error('Không mở được thư mục kết quả.');
  return runner.outputDir;
});
handle('export-pending', async () => {
  if (!runner || isBusy()) throw new Error('Chờ tạm dừng hoặc hoàn tất trước khi xuất.');
  const current = runner;
  const lines = current.pendingLines();
  const result = await dialog.showSaveDialog(win, { title: 'Xuất dòng chưa kiểm tra và unchecked', defaultPath: path.join(current.outputDir, 'pending.txt'), filters: [{ name: 'Text files', extensions: ['txt'] }] });
  if (result.canceled) return null;
  const destination = path.resolve(cleanPath(result.filePath));
  const protectedPaths = [current.accountPath, current.proxyPath, ...['valid', 'invalid', 'unchecked'].map(status => path.join(current.outputDir, `${status}.txt`))];
  const canonical = file => {
    try { return fs.realpathSync(file); } catch { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
  };
  const sameFile = file => {
    if (canonical(file) === canonical(destination)) return true;
    try {
      const a = fs.statSync(file), b = fs.statSync(destination);
      return a.dev === b.dev && a.ino === b.ino;
    } catch { return false; }
  };
  if (protectedPaths.filter(Boolean).some(sameFile)) throw new Error('Chọn file khác để giữ nguyên dữ liệu đầu vào và kết quả.');
  fs.writeFileSync(destination, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return { count: lines.length, path: destination };
});

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { closing = false; createWindow(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (isBusy()) {
    event.preventDefault();
    runner.pause();
    closing = true;
    if (!quitRequested) { quitRequested = true; runPromise.finally(() => app.quit()); }
  }
});
