/**
 * CDP-based auto-navigation for X.com.
 *
 * Drives Chrome through key X.com pages to trigger GraphQL API calls,
 * so the NetworkRecorder captures the full API surface without manual browsing.
 */

import { getLogger } from '../../util/logger.js';

const log = getLogger('x-auto-navigate');

const CDP_BASE = 'http://localhost:9222';

interface NavStep {
  label: string;
  url?: string;
  clickSelector?: string;
}

/** Minimal CDP client — connects to one page tab. */
class MiniCDP {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = (e) => reject(new Error(`CDP error: ${e}`));
      ws.onclose = () => { this.ws = null; };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id != null) {
          const cb = this.callbacks.get(msg.id);
          if (cb) {
            this.callbacks.delete(msg.id);
            if (msg.error) { cb.reject(new Error(msg.error.message)); } else { cb.resolve(msg.result); }
          }
        }
      };
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) throw new Error('Not connected');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.ws?.close(); }
}

/**
 * Navigate Chrome through X.com pages to trigger GraphQL calls.
 * The NetworkRecorder should already be attached and capturing.
 *
 * @param abortSignal Optional signal to stop navigation early.
 * @returns List of step labels that completed successfully.
 */
export async function navigateXPages(abortSignal?: { aborted: boolean }): Promise<string[]> {
  let wsUrl: string | null = null;
  try {
    const res = await fetch(`${CDP_BASE}/json/list`);
    if (!res.ok) {
      log.warn('CDP not available for auto-navigation');
      return [];
    }
    const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const xTab = targets.find(
      t => t.type === 'page' && (t.url.includes('x.com') || t.url.includes('twitter.com')),
    );
    wsUrl = xTab?.webSocketDebuggerUrl ?? targets.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  } catch (err) {
    log.warn({ err }, 'Failed to discover Chrome tabs');
    return [];
  }

  if (!wsUrl) {
    log.warn('No Chrome tab found for auto-navigation');
    return [];
  }

  const cdp = new MiniCDP();
  try {
    await cdp.connect(wsUrl);
  } catch (err) {
    log.warn({ err }, 'Failed to connect CDP for auto-navigation');
    return [];
  }

  await cdp.send('Page.enable').catch(() => {});
  const completed: string[] = [];

  // Navigate to home first to discover the screen name
  try {
    await cdp.send('Page.navigate', { url: 'https://x.com/home' });
    await sleep(3000);
  } catch (err) {
    log.warn({ err }, 'Failed to navigate to home');
    cdp.close();
    return [];
  }

  // Resolve screen name for profile-based URLs
  let screenName: string | null = null;
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (link) return link.getAttribute('href')?.replace('/', '') ?? null;
          return null;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    }) as { result?: { value?: string | null } };
    screenName = result?.result?.value ?? null;
  } catch { /* ignore */ }

  log.info({ screenName }, 'Detected screen name');

  // Build steps with resolved URLs
  const steps: NavStep[] = [
    { label: 'Home timeline', url: 'https://x.com/home' },
    { label: 'Profile', clickSelector: 'a[data-testid="AppTabBar_Profile_Link"]' },
    { label: 'Tweet detail', clickSelector: 'article[data-testid="tweet"] a[href*="/status/"]' },
    { label: 'Search', url: 'https://x.com/search?q=hello&src=typed_query' },
    { label: 'Bookmarks', url: 'https://x.com/i/bookmarks' },
    { label: 'Notifications', url: 'https://x.com/notifications' },
  ];

  // Add profile-based URLs if we have the screen name
  if (screenName) {
    steps.push(
      { label: 'Likes', url: `https://x.com/${screenName}/likes` },
      { label: 'Followers', url: `https://x.com/${screenName}/followers` },
      { label: 'Following', url: `https://x.com/${screenName}/following` },
      { label: 'Media', url: `https://x.com/${screenName}/media` },
    );
  }

  for (const step of steps) {
    if (abortSignal?.aborted) break;

    log.info({ step: step.label }, 'Auto-navigate step starting');

    try {
      if (step.url) {
        await cdp.send('Page.navigate', { url: step.url });
        await sleep(3000);
      }

      if (step.clickSelector) {
        await sleep(1500);
        await clickInPage(cdp, step.clickSelector);
        await sleep(2000);
      }

      // Scroll to trigger lazy-loaded content
      await cdp.send('Runtime.evaluate', {
        expression: 'window.scrollBy(0, 800)',
        awaitPromise: false,
      }).catch(() => {});

      await sleep(2000);

      completed.push(step.label);
      log.info({ step: step.label }, 'Auto-navigate step completed');
    } catch (err) {
      log.warn({ err, step: step.label }, 'Auto-navigate step failed');
    }
  }

  cdp.close();
  log.info({ completed: completed.length, total: steps.length }, 'Auto-navigation finished');
  return completed;
}

async function clickInPage(cdp: MiniCDP, selector: string): Promise<boolean> {
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    }) as { result?: { value?: boolean } };
    return result?.result?.value === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
