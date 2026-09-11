import { createCdpProxy } from './cdp-proxy.js';
import { trackDesktopInput } from './managed-desktop-input.js';
import { createHostBrowserDispatcher, type HostBrowserRequestEnvelope } from './host-browser-dispatcher.js';

const input = trackDesktopInput(createCdpProxy());

let port: ChromeRuntimePort | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  if (port) {
    return;
  }
  clearTimeout(retry);
  const connection = chrome.runtime.connectNative('ai.vellum.desktop');
  port = connection;
  const post = (message: unknown) => connection.postMessage(message);
  const dispatcher = createHostBrowserDispatcher({
    // The worker owns input tracking across native connections.
    cdpProxy: { ...input.proxy, dispose: () => {} },
    releaseInput: input.release,
    resolveTarget: async (id) => {
      if (!id || !/^\d+$/.test(id)) {
        throw new Error('A desktop tab must be selected');
      }
      const tab = await chrome.tabs.get(Number(id));
      if (!tab.id) {
        throw new Error('Desktop tab is closed');
      }
      return { tabId: tab.id };
    },
    createTab: async (signal) => {
      signal?.throwIfAborted();
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      signal?.throwIfAborted();
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { tabId: tab.id };
    },
    postResult: async (message) => post(message),
    forwardCdpEvent: (event) => {
      if (["Page.frameNavigated", "Page.navigatedWithinDocument", "DOM.documentUpdated", "Runtime.executionContextsCleared"].includes(event.method)) {
        post({ type: "host_browser_session_invalidated", reason: event.method });
      }
    },
    forwardSessionInvalidated: post,
  });
  connection.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    const envelope = message as Record<string, unknown>;
    if (envelope.type === 'host_browser_request') {
      void dispatcher.handle(envelope as unknown as HostBrowserRequestEnvelope);
    } else if (envelope.type === 'host_browser_cancel' && typeof envelope.requestId === 'string') {
      dispatcher.cancel({ type: 'host_browser_cancel', requestId: envelope.requestId });
    }
  });
  connection.onDisconnect.addListener(() => {
    dispatcher.dispose();
    void input.release().catch(() => {});
    port = undefined;
    clearTimeout(retry);
    retry = setTimeout(connect, 3_000);
  });
  void input.release().then(() => {
    if (port === connection) {
      post({ type: 'desktop_browser_hello', version: chrome.runtime.getManifest().version, protocol: 1 });
    }
  }).catch(() => connection.disconnect());
}

chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
void chrome.alarms.create('desktop-connect', { periodInMinutes: 0.5 });
connect();
