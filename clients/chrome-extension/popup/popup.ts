/**
 * Popup UI for the Vellum browser-relay extension.
 *
 * Auto-fetches a bearer token from the local gateway on Connect.
 * Falls back to manual token entry if the gateway is unreachable.
 */

const DEFAULT_RELAY_PORT = 7830;

const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btn-disconnect') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLParagraphElement;
const errorText = document.getElementById('error-text') as HTMLParagraphElement;
const manualToggle = document.getElementById('manual-toggle') as HTMLButtonElement;
const tokenGroup = document.getElementById('token-group') as HTMLDivElement;

let manualMode = false;

function setConnected(connected: boolean): void {
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'Connected to relay server' : 'Not connected';
  btnConnect.disabled = connected;
  btnDisconnect.disabled = !connected;
  tokenInput.disabled = connected;
  portInput.disabled = connected;
  if (connected) {
    errorText.style.display = 'none';
  }
}

function showError(msg: string): void {
  errorText.textContent = msg;
  errorText.style.display = 'block';
  // Reveal manual token entry on auto-fetch failure
  if (!manualMode) {
    manualMode = true;
    tokenGroup.classList.add('visible');
    manualToggle.textContent = 'Hide manual token entry';
  }
}

manualToggle.addEventListener('click', () => {
  manualMode = !manualMode;
  tokenGroup.classList.toggle('visible', manualMode);
  manualToggle.textContent = manualMode ? 'Hide manual token entry' : 'Manual token entry';
});

// Load saved token and port on open
chrome.storage.local.get(['bearerToken', 'relayPort']).then((result) => {
  if (typeof result.bearerToken === 'string' && result.bearerToken) {
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

function getPort(): number {
  const portStr = portInput.value.trim();
  if (portStr) {
    const portNum = parseInt(portStr, 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) return portNum;
  }
  return DEFAULT_RELAY_PORT;
}

async function fetchTokenFromGateway(port: number): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/v1/browser-relay/token`);
  if (!resp.ok) {
    throw new Error(`Gateway returned ${resp.status}`);
  }
  const data = await resp.json();
  if (typeof data.token !== 'string') {
    throw new Error('Invalid token response');
  }
  return data.token;
}

btnConnect.addEventListener('click', async () => {
  const port = getPort();
  const storageUpdate: Record<string, unknown> = { autoConnect: true };

  errorText.style.display = 'none';

  // Only honour the manual token input when the user has explicitly revealed
  // it.  When manual mode is hidden, always auto-fetch a fresh token from the
  // gateway so we never silently reuse an expired JWT that was pre-loaded from
  // storage.
  let token = manualMode ? tokenInput.value.trim() : '';

  if (!token) {
    try {
      btnConnect.disabled = true;
      statusText.textContent = 'Fetching token…';
      token = await fetchTokenFromGateway(port);
    } catch (err) {
      btnConnect.disabled = false;
      showError(`Could not auto-fetch token: ${err instanceof Error ? err.message : String(err)}`);
      statusText.textContent = 'Not connected';
      return;
    }
  }

  if (token) storageUpdate.bearerToken = token;
  if (portInput.value.trim()) {
    storageUpdate.relayPort = port;
  } else {
    await chrome.storage.local.remove('relayPort');
  }
  await chrome.storage.local.set(storageUpdate);

  chrome.runtime.sendMessage({ type: 'connect' }, (response: { ok: boolean; error?: string }) => {
    if (chrome.runtime.lastError || !response?.ok) {
      showError(response?.error ?? chrome.runtime.lastError?.message ?? 'Unknown error');
      btnConnect.disabled = false;
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
