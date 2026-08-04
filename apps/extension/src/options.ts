/** 选项页：访问令牌与服务端地址写入 chrome.storage.local；令牌值不回显日志（SEC-04）。 */
import {
  AUTOMATION_DESCRIPTORS_KEY,
  autoScanEnabledKeyFor,
  autoScanMinutesKeyFor,
  DEFAULT_AUTO_SCAN_MINUTES,
  parseAutomationDescriptors,
  type AutomationDescriptor,
} from './auto-scan.js';

const TOKEN_KEY = 'za.token';
const BASEURL_KEY = 'za.serverBaseUrl';

const tokenInput = document.getElementById('token') as HTMLTextAreaElement;
const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;
const automationsContainer = document.getElementById('automations') as HTMLElement;
const automationsHint = document.getElementById('automationsHint') as HTMLElement;

interface AutomationControl {
  automationId: string;
  enabledInput: HTMLInputElement;
  minutesInput: HTMLInputElement;
}
const automationControls: AutomationControl[] = [];

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.className = isError ? 'err' : '';
}

function renderAutomations(descriptors: AutomationDescriptor[], stored: Record<string, unknown>): void {
  automationControls.length = 0;
  automationsContainer.replaceChildren();
  automationsHint.hidden = descriptors.length === 0;
  for (const descriptor of descriptors) {
    const automationId = descriptor.automation.id;
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'check';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = stored[autoScanEnabledKeyFor(automationId)] === true;
    enabledLabel.append(enabledInput, `启用周期自动化「${automationId}」（${descriptor.origin}）`);

    const minutesLabel = document.createElement('label');
    minutesLabel.textContent = '周期（分钟）';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '1–60';
    minutesLabel.append(hint);
    const minutesInput = document.createElement('input');
    minutesInput.type = 'number';
    minutesInput.min = '1';
    minutesInput.max = '60';
    minutesInput.step = '1';
    const storedMinutes = stored[autoScanMinutesKeyFor(automationId)];
    minutesInput.value = String(
      typeof storedMinutes === 'number'
        ? storedMinutes
        : descriptor.automation.defaultPeriodMinutes ?? DEFAULT_AUTO_SCAN_MINUTES,
    );

    automationsContainer.append(enabledLabel, minutesLabel, minutesInput);
    automationControls.push({ automationId, enabledInput, minutesInput });
  }
}

void chrome.storage.local.get(null).then((items) => {
  const token = items[TOKEN_KEY];
  const baseUrl = items[BASEURL_KEY];
  if (typeof token === 'string') tokenInput.value = token;
  if (typeof baseUrl === 'string') baseUrlInput.value = baseUrl;
  renderAutomations(parseAutomationDescriptors(items[AUTOMATION_DESCRIPTORS_KEY]), items);
});

saveButton.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  if (token === '') {
    showStatus('访问令牌不能为空', true);
    return;
  }
  const entries: Record<string, unknown> = { [TOKEN_KEY]: token };
  for (const control of automationControls) {
    const minutes = Number(control.minutesInput.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      showStatus(`自动化「${control.automationId}」周期必须是 1 到 60 分钟的整数`, true);
      return;
    }
    entries[autoScanEnabledKeyFor(control.automationId)] = control.enabledInput.checked;
    entries[autoScanMinutesKeyFor(control.automationId)] = minutes;
  }
  void (baseUrl === ''
    ? chrome.storage.local.remove(BASEURL_KEY)
    : chrome.storage.local.set({ [BASEURL_KEY]: baseUrl })
  )
    .then(() => chrome.storage.local.set(entries))
    .then(() => showStatus('已保存；重新打开宿主页面生效'))
    .catch(() => showStatus('保存失败，请重试', true));
});
