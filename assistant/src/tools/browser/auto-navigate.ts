/**
 * CDP-based auto-navigation for any domain.
 *
 * Drives Chrome through a domain's pages by discovering internal links,
 * so the NetworkRecorder captures the API surface without manual browsing.
 */

import { getLogger } from '../../util/logger.js';

const log = getLogger('auto-navigate');

const CDP_BASE = 'http://localhost:9222';
const MAX_PAGES = 10;
const PAGE_WAIT_MS = 2500;
const SCROLL_WAIT_MS = 1000;

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

export interface AutoNavProgress {
  type: 'visiting' | 'discovered' | 'done';
  url?: string;
  pageNumber?: number;
  totalDiscovered?: number;
  visitedCount?: number;
}

/**
 * Navigate Chrome through a domain's pages to trigger API calls.
 * Discovers internal links from the DOM and visits up to ~15 unique paths.
 *
 * @param domain The domain to crawl (e.g. "example.com").
 * @param abortSignal Optional signal to stop navigation early.
 * @param onProgress Optional callback for live progress updates.
 * @returns List of visited page URLs.
 */
export async function autoNavigate(
  domain: string,
  abortSignal?: { aborted: boolean },
  onProgress?: (p: AutoNavProgress) => void,
): Promise<string[]> {
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

  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Page.enable').catch(() => {});

  const rootUrl = `https://${domain}/`;
  const visited = new Set<string>();
  const visitedUrls: string[] = [];

  // Navigate to the domain root first
  try {
    onProgress?.({ type: 'visiting', url: rootUrl, pageNumber: 1 });
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

  // Discover internal links from the current page
  let discoveredLinks = await discoverInternalLinks(cdp, domain);
  // Sort links: deeper paths first (more likely to be content pages), skip shallow nav links
  discoveredLinks = rankLinks(discoveredLinks);
  onProgress?.({ type: 'discovered', totalDiscovered: discoveredLinks.length });
  log.info({ count: discoveredLinks.length }, 'Discovered internal links from root');

  // Visit discovered pages
  for (const link of discoveredLinks) {
    if (abortSignal?.aborted) break;
    if (visited.size >= MAX_PAGES) break;
    if (visited.has(link.key)) continue;

    const url = link.url;
    onProgress?.({ type: 'visiting', url, pageNumber: visited.size + 1, totalDiscovered: discoveredLinks.length });
    log.info({ url }, 'Auto-navigate visiting page');

    try {
      await cdp.send('Page.navigate', { url });
      await sleep(PAGE_WAIT_MS);
      visited.add(link.key);
      visitedUrls.push(url);

      // Scroll to trigger lazy-loaded content
      await scrollPage(cdp);
      await sleep(SCROLL_WAIT_MS);

      // Click tabs/buttons within the page (NOT nav links — those navigate away)
      await clickPageTabs(cdp);
      await sleep(800);

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
  onProgress?.({ type: 'done', visitedCount: visitedUrls.length, totalDiscovered: discoveredLinks.length });
  log.info({ visited: visitedUrls.length, total: discoveredLinks.length + 1 }, 'Auto-navigation finished');
  return visitedUrls;
}

interface DiscoveredLink {
  /** Full URL to navigate to (preserves subdomain). */
  url: string;
  /** Deduplication key: origin + pathname. */
  key: string;
  /** Path depth (number of segments). */
  depth: number;
}

/** Paths that are typically navigation chrome, not content pages. */
const SKIP_PATHS = [
  '/home', '/login', '/signup', '/register', '/sign-up', '/sign-in',
  '/help', '/support', '/contact', '/about', '/terms', '/privacy',
  '/careers', '/press', '/blog', '/faq', '/sitemap',
];

/** Path patterns that indicate high-value purchase/content flows. */
const HIGH_VALUE_PATTERNS = [
  /\/orders/i, /\/cart/i, /\/checkout/i, /\/account/i, /\/settings/i,
  /\/store\//i, /\/restaurant\//i, /\/menu/i, /\/payment/i,
  /\/profile/i, /\/history/i, /\/favorites/i, /\/saved/i,
  /\/search/i, /\/category/i, /\/collection/i,
];

/** Sort links to prioritize purchase/content flows, deduplicate by pattern. */
function rankLinks(links: DiscoveredLink[]): DiscoveredLink[] {
  const filtered = links.filter(l => {
    const path = new URL(l.url).pathname.toLowerCase();
    if (SKIP_PATHS.some(skip => path === skip || path === skip + '/')) return false;
    return true;
  });

  // Deduplicate by host+path pattern — keep only one of /store/123, /store/456
  // but preserve different subdomains (shop.example.com vs admin.example.com)
  const byPattern = new Map<string, DiscoveredLink>();
  for (const link of filtered) {
    const parsed = new URL(link.url);
    // Collapse numeric/hash segments to find the pattern
    const pathPattern = parsed.pathname.replace(/\/\d+/g, '/{id}').replace(/\/[a-f0-9]{8,}/gi, '/{id}');
    const pattern = parsed.hostname + pathPattern;
    if (!byPattern.has(pattern)) {
      byPattern.set(pattern, link);
    }
  }

  return [...byPattern.values()].sort((a, b) => {
    const aPath = new URL(a.url).pathname.toLowerCase();
    const bPath = new URL(b.url).pathname.toLowerCase();
    // High-value paths first
    const aHighValue = HIGH_VALUE_PATTERNS.some(p => p.test(aPath)) ? 1 : 0;
    const bHighValue = HIGH_VALUE_PATTERNS.some(p => p.test(bPath)) ? 1 : 0;
    if (aHighValue !== bHighValue) return bHighValue - aHighValue;
    // Then by depth (deeper = more specific)
    return Math.min(b.depth, 4) - Math.min(a.depth, 4);
  });
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
                links.push({
                  url: url.origin + url.pathname,
                  key,
                  depth: path.split('/').filter(Boolean).length,
                });
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
  // Scroll in increments to trigger multiple lazy-load thresholds
  for (let i = 0; i < 3; i++) {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.scrollBy(0, 600)',
      awaitPromise: false,
    }).catch(() => {});
    await sleep(500);
  }
}

/**
 * Click tabs, buttons, and flow-relevant elements within the current page.
 * Avoids clicking navigation links (which would navigate away).
 */
async function clickPageTabs(cdp: MiniCDP): Promise<void> {
  const selectors = [
    '[role="tab"]:not(:first-child)',
    '[role="tablist"] button:not(:first-child)',
    'button[data-tab]',
    '[data-testid*="tab"]',
    'button[aria-expanded="false"]',
  ];

  for (const selector of selectors) {
    await clickInPage(cdp, selector);
    await sleep(600);
  }

  // Also try clicking purchase-flow buttons to trigger API calls
  // (Add to Cart, etc. — these fire API requests even if we don't complete the flow)
  await clickByText(cdp, 'Add to Cart');
  await clickByText(cdp, 'Add to Order');
  await clickByText(cdp, 'Add Item');
}

/** Click a button by its visible text content. */
async function clickByText(cdp: MiniCDP, text: string): Promise<boolean> {
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            if (btn.textContent && btn.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())})) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
          return false;
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
