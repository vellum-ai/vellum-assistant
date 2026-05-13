/**
 * Promise-based wrapper around chrome.runtime.sendMessage with retry
 * logic for MV3 service worker wake-up.
 *
 * Chrome MV3 service workers may not be awake when the popup first
 * opens. If the message port closes before a response is received
 * (chrome.runtime.lastError set, response undefined), we retry once
 * after a short delay to give the worker time to wake.
 */

export function sendMessage<T>(
  message: Record<string, unknown>,
  retries = 1,
): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError && response === undefined && retries > 0) {
        setTimeout(() => {
          sendMessage<T>(message, retries - 1).then(resolve);
        }, 200);
        return;
      }
      resolve(response);
    });
  });
}
