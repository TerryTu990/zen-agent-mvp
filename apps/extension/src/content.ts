import { createContextReporter } from './context-report.js';
import { createConversationUi } from './conversation-hitl.js';
import { createDomGuidePage, createPageActionRunner } from './page-action.js';
import {
  SESSION_PORT_NAME,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
} from './messaging.js';

const PANEL_CSS = `
  .za-panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; flex-direction: column; width: 340px; height: 440px;
    background: #fff; color: #1f2328; border: 1px solid #d0d7de; border-radius: 12px;
    box-shadow: 0 8px 24px rgba(31, 35, 40, 0.15);
    font: 13px/1.5 system-ui, -apple-system, sans-serif;
  }
  .za-header { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid #d0d7de; }
  [data-za-messages] { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
  .za-msg { max-width: 85%; padding: 6px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .za-msg[data-role="user"] { align-self: flex-end; background: #0969da; color: #fff; }
  .za-msg[data-role="assistant"] { align-self: flex-start; background: #f6f8fa; }
  .za-status { align-self: center; color: #cf222e; font-size: 12px; }
  .za-composer { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #d0d7de; }
  #za-input { flex: 1; resize: none; height: 44px; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 8px; font: inherit; }
  #za-send { padding: 0 14px; border: none; border-radius: 8px; background: #0969da; color: #fff; font: inherit; cursor: pointer; }
`;

interface Panel {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
}

function mountPanel(): Panel {
  const host = document.createElement('div');
  host.id = 'za-root';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;

  const panel = document.createElement('div');
  panel.className = 'za-panel';

  const header = document.createElement('div');
  header.className = 'za-header';
  header.textContent = 'zen-agent';

  const messages = document.createElement('div');
  messages.setAttribute('data-za-messages', '');

  const composer = document.createElement('div');
  composer.className = 'za-composer';
  const input = document.createElement('textarea');
  input.id = 'za-input';
  const sendButton = document.createElement('button');
  sendButton.id = 'za-send';
  sendButton.textContent = '发送';
  composer.append(input, sendButton);

  panel.append(header, messages, composer);
  shadow.append(style, panel);
  document.documentElement.append(host);
  return { messages, input, sendButton };
}

function main(): void {
  if (document.getElementById('za-root') !== null) return;
  const { messages, input, sendButton } = mountPanel();
  const ui = createConversationUi(messages);
  const pageAction = createPageActionRunner(createDomGuidePage());
  const port = chrome.runtime.connect({ name: SESSION_PORT_NAME });
  const send = (message: ContentToBackgroundMessage) => port.postMessage(message);

  port.onMessage.addListener((raw) => {
    const message = raw as BackgroundToContentMessage;
    if (message.kind === 'status') {
      ui.showStatus(message.message);
    } else if (message.kind === 'frame' && message.frame.type === 'text-delta') {
      ui.appendTextDelta(message.frame);
    } else if (message.kind === 'frame' && message.frame.type === 'guide-action') {
      ui.showStatus(pageAction.run(message.frame).status);
    }
  });

  send({ kind: 'context-report', ...createContextReporter().collect() });

  const submit = () => {
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    ui.appendUserMessage(text);
    send({ kind: 'user-message', text });
  };
  sendButton.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
}

main();
