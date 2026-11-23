const $ = id => document.getElementById(id);
let state = null;
let commandPending = false;
let lastRecent = '';
const statusLabels = { ready: 'Sẵn sàng', running: 'Đang kiểm tra', pausing: 'Đang tạm dừng…', paused: 'Đã tạm dừng', completed: 'Hoàn tất', failed: 'Lỗi ghi kết quả' };
const reasons = {
  authenticated: 'Đăng nhập được chấp nhận', additional_verification_required: 'Cần xác minh thêm / CHBM',
  incorrect_credentials: 'Sai thông tin đăng nhập', account_locked: 'Tài khoản bị khóa',
  network_or_service: 'Lỗi mạng / proxy / dịch vụ', unknown_response: 'Phản hồi chưa xác định',
  network_error: 'Lỗi mạng / kết nối', proxy_error: 'Lỗi proxy', timeout: 'Quá thời gian chờ', service_unavailable: 'Dịch vụ tạm lỗi (HTTP 503)',
  invalid_input: 'Sai định dạng email|password', request_failed: 'Không hoàn tất được yêu cầu'
};
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}${message ? '' : ' hidden'}`;
}
function render(next) {
  const changed = state?.status !== next?.status;
  state = next;
  const busy = ['running', 'pausing'].includes(state?.status) || (state?.active || 0) > 0;
  const locked = !!state || commandPending;
  for (const id of ['account-path', 'proxy-path', 'concurrency', 'choose-account', 'choose-proxy', 'output-folder', 'choose-output']) $(id).disabled = locked;
  if (state?.outputRoot) $('output-folder').value = state.outputRoot;
  $('start').disabled = commandPending || busy || state?.status === 'completed';
  $('start').textContent = ['paused', 'failed'].includes(state?.status) ? 'Tiếp tục kiểm tra' : 'Bắt đầu kiểm tra';
  $('pause').disabled = commandPending || state?.status !== 'running';
  $('reset').disabled = commandPending || busy || !state;
  $('open-results').disabled = commandPending || !state;
  $('export-pending').disabled = commandPending || busy || !state;
  $('status').textContent = statusLabels[state?.status] || 'Sẵn sàng';
  $('status').className = `status ${state?.status || ''}`;
  for (const key of ['processed', 'total', 'valid', 'invalid', 'unchecked']) $(key).textContent = state?.[key] || 0;
  const seconds = state?.elapsedSeconds || 0;
  $('elapsed').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  const percent = state?.total ? Math.floor(state.processed / state.total * 100) : 0;
  $('progress').value = percent;
  $('progress-label').textContent = state ? `${percent}% hoàn thành` : 'Chưa có phiên chạy';
  $('work-detail').textContent = state ? `${state.active} đang chạy · ${state.pending} đang chờ · ${state.concurrency} luồng` : 'Chọn dữ liệu và bắt đầu kiểm tra.';
  $('duplicate-detail').textContent = state?.duplicates ? `Đã bỏ ${state.duplicates} dòng trùng` : '';
  $('output-path').textContent = state?.outputDir || 'Kết quả được tự động lưu vào valid.txt, invalid.txt và unchecked.txt, trong thư mục riêng của từng phiên.';
  const recentKey = JSON.stringify(state?.recent || []);
  if (recentKey !== lastRecent) {
    lastRecent = recentKey;
    $('recent').replaceChildren();
    for (const row of state?.recent || []) {
      const tr = document.createElement('tr');
      for (const value of [row.lineNumber, row.reason === 'invalid_input' ? '(dữ liệu không hợp lệ)' : row.email, row.status, reasons[row.reason] || row.reason]) {
        const td = document.createElement('td');
        if (tr.children.length === 2) {
          const badge = document.createElement('span');
          badge.className = `badge ${row.status}`;
          badge.textContent = value;
          td.append(badge);
        } else td.textContent = value;
        tr.append(td);
      }
      $('recent').append(tr);
    }
    if (!$('recent').children.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4; td.className = 'empty'; td.textContent = 'Kết quả mới nhất sẽ xuất hiện tại đây.';
      tr.append(td); $('recent').append(tr);
    }
  }
  if (state?.error) notice(state.error, true);
  else if (changed && state?.status === 'pausing') notice('Đã ngừng nhận dòng mới và ngừng bắt đầu retry. Chờ tác vụ đang chạy kết thúc (tối đa khoảng 90 giây).');
  else if (changed && state?.status === 'completed') notice('Đã hoàn tất và lưu kết quả. Xuất chưa kiểm tra sẽ gồm cả các dòng unchecked.');
  else if (changed && state?.status === 'paused') notice('Đã tạm dừng. Tiếp tục sẽ chạy các dòng đang chờ trong cùng phiên.');
}
async function command(fn) {
  if (commandPending) return;
  commandPending = true;
  notice(''); render(state);
  try {
    const response = await fn();
    if (!response.ok) throw new Error(response.error);
    return response.value;
  } catch (error) { notice(error.message, true); }
  finally { commandPending = false; render(state); }
}
function inputConfig() {
  return { accountPath: $('account-path').value, proxyPath: $('proxy-path').value, concurrency: $('concurrency').value, outputFolder: $('output-folder').value };
}
function savePreferences() {
  try { localStorage.setItem('apple-checker-inputs', JSON.stringify(inputConfig())); } catch { /* Preferences are optional. */ }
}
for (const id of ['account-path', 'proxy-path', 'concurrency', 'output-folder']) $(id).addEventListener('change', savePreferences);
for (const [button, input, kind] of [['choose-account', 'account-path', 'account'], ['choose-proxy', 'proxy-path', 'proxy']]) {
  $(button).addEventListener('click', () => command(async () => {
    const response = await window.electronAPI.chooseFile(kind);
    if (response.ok && response.value) { $(input).value = response.value; savePreferences(); }
    return response;
  }));
}
$('choose-output').addEventListener('click', () => command(async () => {
  const response = await window.electronAPI.chooseOutputFolder($('output-folder').value);
  if (response.ok && response.value) { $('output-folder').value = response.value; savePreferences(); }
  return response;
}));
$('start').addEventListener('click', () => command(async () => {
  const config = inputConfig();
  savePreferences();
  const response = await window.electronAPI.start(config);
  if (response.ok) render(response.value);
  return response;
}));
$('pause').addEventListener('click', () => command(() => window.electronAPI.pause()));
$('reset').addEventListener('click', () => command(async () => {
  const response = await window.electronAPI.reset();
  if (response.ok) { notice(''); render(null); }
  return response;
}));
$('open-results').addEventListener('click', () => command(() => window.electronAPI.openResults()));
$('export-pending').addEventListener('click', () => command(async () => {
  const response = await window.electronAPI.exportPending();
  if (response.ok && response.value) notice(`Đã xuất ${response.value.count} dòng: ${response.value.path}`);
  return response;
}));
try {
  const saved = JSON.parse(localStorage.getItem('apple-checker-inputs') || 'null');
  if (saved) { $('account-path').value = saved.accountPath || ''; $('proxy-path').value = saved.proxyPath || ''; $('concurrency').value = saved.concurrency || 5; $('output-folder').value = saved.outputFolder || ''; }
} catch { /* Ignore malformed preferences. */ }
window.electronAPI.onState(render);
command(async () => {
  const response = await window.electronAPI.getState();
  if (response.ok) render(response.value);
  return response;
});
