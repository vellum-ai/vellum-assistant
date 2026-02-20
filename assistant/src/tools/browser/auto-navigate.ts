/**
 * CDP-based auto-navigation for any domain.
 *
 * Drives Chrome through a domain's pages by discovering internal links,
 * so the NetworkRecorder captures the API surface without manual browsing.
 */

import { getLogger } from '../../util/logger.js';

const log = getLogger('auto-navigate');

const CDP_BASE = 'http://localhost:9222';
const MAX_PAGES = 15;
const PAGE_WAIT_MS = 3500;
const SCROLL_WAIT_MS = 2000;

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
      ws.onclose = () => {
        this.ws = null;
        for (const [, cb] of this.callbacks) {
          cb.reject(new Error('WebSocket closed'));
        }
        this.callbacks.clear();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id != null) {
          const cb = this.callbacks.get(msg.id);
          if (cb) {
            this.callbacks.delete(msg.id);
            msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
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
 * Navigate Chrome through a domain's pages to trigger API calls.
 * Discovers internal links from the DOM and visits up to ~15 unique paths.
 *
 * @param domain The domain to crawl (e.g. "example.com").
 * @param abortSignal Optional signal to stop navigation early.
 * @returns List of visited page URLs.
 */
export async function autoNavigate(domain: string, abortSignal?: { aborted: boolean }): Promise<string[]> {
  let wsUrl: string | null = null;
  try {
    const res = await fetch(`${CDP_BASE}/json/list`);
    if (!res.ok) {
      log.warn('CDP not available for auto-navigation');
      return [];
    }
    const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const domainTab = targets.find(t => {
      if (t.type !== 'page') return false;
      try {
        const hostname = new URL(t.url).hostname;
        return hostname === domain || hostname.endsWith('.' + domain);
      } catch { return false; }
    });
    wsUrl = domainTab?.webSocketDebuggerUrl ?? targets.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null;
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

  const rootUrl = `https://${domain}/`;
  const visited = new Set<string>();
  const visitedUrls: string[] = [];

  // Navigate to the domain root first
  try {
    await cdp.send('Page.navigate', { url: rootUrl });
    await sleep(PAGE_WAIT_MS);
    visited.add('/');
    visitedUrls.push(rootUrl);
    log.info({ url: rootUrl }, 'Visited root page');
  } catch (err) {
    log.warn({ err }, 'Failed to navigate to domain root');
    cdp.close();
    return [];
  }

  if (abortSignal?.aborted) { cdp.close(); return visitedUrls; }

  // Scroll the root page to trigger lazy content
  await scrollPage(cdp);
  await sleep(SCROLL_WAIT_MS);

  // Click common interactive elements on the root page
  await clickInteractiveElements(cdp);
  await sleep(SCROLL_WAIT_MS);

  // Discover internal links from the current page
  let discoveredLinks = await discoverInternalLinks(cdp, domain);
  log.info({ count: discoveredLinks.length }, 'Discovered internal links from root');

  // Visit discovered pages
  for (const link of discoveredLinks) {
    if (abortSignal?.aborted) break;
    if (visited.size >= MAX_PAGES) break;
    if (visited.has(link.key)) continue;

    const url = link.url;
    log.info({ url }, 'Auto-navigate visiting page');

    try {
      await cdp.send('Page.navigate', { url });
      await sleep(PAGE_WAIT_MS);
      visited.add(link.key);
      visitedUrls.push(url);

      // Scroll to trigger lazy-loaded content
      await scrollPage(cdp);
      await sleep(SCROLL_WAIT_MS);

      // Click interactive elements to trigger more API calls
      await clickInteractiveElements(cdp);
      await sleep(1500);

      // Discover more links from this page
      const newLinks = await discoverInternalLinks(cdp, domain);
      for (const nl of newLinks) {
        if (!visited.has(nl.key) && !discoveredLinks.some(l => l.key === nl.key)) {
          discoveredLinks.push(nl);
        }
      }

      log.info({ url }, 'Auto-navigate page completed');
    } catch (err) {
      log.warn({ err, url }, 'Auto-navigate page failed');
    }
  }

  cdp.close();
  log.info({ visited: visitedUrls.length, total: discoveredPaths.length + 1 }, 'Auto-navigation finished');
  return visitedUrls;
}

interface DiscoveredLink {
  /** Full URL to navigate to (preserves subdomain). */
  url: string;
  /** Deduplication key: origin + pathname. */
  key: string;
}

/** Extract internal links from the current page DOM, preserving subdomains. */
async function discoverInternalLinks(cdp: MiniCDP, domain: string): Promise<DiscoveredLink[]> {
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const domain = ${JSON.stringify(domain)};
          const seen = new Set();
          const links = [];
          for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            if (!href) continue;
            try {
              const url = new URL(href, location.origin);
              if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) continue;
              const path = url.pathname;
              // Skip anchors, query-only links, file downloads, and trivial paths
              if (path === '/' || path === '') continue;
              if (path.match(/\\.(png|jpg|jpeg|gif|svg|css|js|woff|pdf|zip)$/i)) continue;
              const key = url.origin + url.pathname;
              if (!seen.has(key)) {
                seen.add(key);
                links.push({ url: url.origin + url.pathname, key });
              }
            } catch { /* skip malformed URLs */ }
          }
          return links;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    }) as { result?: { value?: DiscoveredLink[] } };
    return result?.result?.value ?? [];
  } catch {
    return [];
  }
}

/** Scroll the page to trigger lazy-loaded content. */
async function scrollPage(cdp: MiniCDP): Promise<void> {
  await cdp.send('Runtime.evaluate', {
    expression: 'window.scrollBy(0, 800)',
    awaitPromise: false,
  }).catch(() => {});
}

/** Click common interactive elements (tabs, nav buttons) to trigger API calls. */
async function clickInteractiveElements(cdp: MiniCDP): Promise<void> {
  const selectors = [
    'nav a:not([href="/"])',
    '[role="tab"]',
    '[role="tablist"] button',
    'button[data-tab]',
    '.tab, .nav-tab, .nav-link',
  ];

  for (const selector of selectors) {
    await clickInPage(cdp, selector);
    await sleep(800);
  }
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
