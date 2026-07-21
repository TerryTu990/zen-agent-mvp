/** 选项页：访问令牌与服务端地址写入 chrome.storage.local；令牌值不回显日志（SEC-04）。 */
const TOKEN_KEY = 'za.token';
const BASEURL_KEY = 'za.serverBaseUrl';
const AUTO_SCAN_ENABLED_KEY = 'za.xianyuAutoScanEnabled';
const AUTO_SCAN_MINUTES_KEY = 'za.xianyuAutoScanMinutes';

const tokenInput = document.getElementById('token') as HTMLTextAreaElement;
const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;
const autoScanInput = document.getElementById('xianyuAutoScan') as HTMLInputElement;
const autoScanMinutesInput = document.getElementById('xianyuAutoScanMinutes') as HTMLInputElement;

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.className = isError ? 'err' : '';
}

void chrome.storage.local.get([TOKEN_KEY, BASEURL_KEY, AUTO_SCAN_ENABLED_KEY, AUTO_SCAN_MINUTES_KEY]).then((items) => {
  const token = items[TOKEN_KEY];
  const baseUrl = items[BASEURL_KEY];
  if (typeof token === 'string') tokenInput.value = token;
  if (typeof baseUrl === 'string') baseUrlInput.value = baseUrl;
  autoScanInput.checked = items[AUTO_SCAN_ENABLED_KEY] === true;
  autoScanMinutesInput.value = String(
    typeof items[AUTO_SCAN_MINUTES_KEY] === 'number' ? items[AUTO_SCAN_MINUTES_KEY] : 5,
  );
});

saveButton.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const autoScanMinutes = Number(autoScanMinutesInput.value);
  if (token === '') {
    showStatus('访问令牌不能为空', true);
    return;
  }
  if (!Number.isInteger(autoScanMinutes) || autoScanMinutes < 1 || autoScanMinutes > 60) {
    showStatus('闲鱼扫描周期必须是 1 到 60 分钟的整数', true);
    return;
  }
  const entries: Record<string, string> = { [TOKEN_KEY]: token };
  void (baseUrl === ''
    ? chrome.storage.local.remove(BASEURL_KEY)
    : chrome.storage.local.set({ [BASEURL_KEY]: baseUrl })
  )
    .then(() => chrome.storage.local.set({
      ...entries,
      [AUTO_SCAN_ENABLED_KEY]: autoScanInput.checked,
      [AUTO_SCAN_MINUTES_KEY]: autoScanMinutes,
    }))
    .then(() => showStatus('已保存；重新打开宿主页面生效'))
    .catch(() => showStatus('保存失败，请重试', true));
});
