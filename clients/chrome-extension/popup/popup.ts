/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Lets the user paste their bearer token, connect / disconnect, and see
 * live connection status.
 */

const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btn-disconnect') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLParagraphElement;

function setConnected(connected: boolean): void {
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'Connected to relay server' : 'Not connected';
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
  tokenInput.disabled = connected;
  portInput.disabled = connected;
}

// Load saved token and port on open
chrome.storage.local.get(['bearerToken', 'relayPort']).then((result) => {
  if (typeof result.bearerToken === 'string') {
    tokenInput.value = result.bearerToken;
  }
  if (result.relayPort !== undefined) {
    portInput.value = String(result.relayPort);
  }
});

// Query current status from service worker
chrome.runtime.sendMessage({ type: 'get_status' }, (response: { connected: boolean }) => {
  if (chrome.runtime.lastError) return;
  setConnected(response?.connected ?? false);
});

btnConnect.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const portStr = portInput.value.trim();
  const storageUpdate: Record<string, unknown> = { autoConnect: true };
  if (token) storageUpdate.bearerToken = token;
  if (portStr) {
    const portNum = parseInt(portStr, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
      storageUpdate.relayPort = portNum;
    }
  }
  await chrome.storage.local.set(storageUpdate);

  chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string }) => {
    if (chrome.runtime.lastError || !response?.ok) {
      statusText.textContent = `Error: ${response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error'}`;
      return;
    }
    // Poll briefly for open state
    let attempts = 0;
    const poll = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'get_status' }, (r: { connected: boolean }) => {
        if (r?.connected || ++attempts > 10) {
          clearInterval(poll);
          setConnected(r?.connected ?? false);
        }
      });
    }, 300);
  });
});

btnDisconnect.addEventListener('click', () => {
  chrome.storage.local.set({ autoConnect: false });
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    setConnected(false);
  });
});
