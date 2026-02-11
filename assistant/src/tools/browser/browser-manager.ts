import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDataDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('browser-manager');

type BrowserContext = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};

export type PageResponse = {
  status(): number | null;
  url(): string;
};

export type RouteHandler = (route: PageRoute, request: PageRequest) => Promise<void> | void;

export type PageRoute = {
  abort(errorCode?: string): Promise<void>;
  continue(options?: Record<string, unknown>): Promise<void>;
};

export type PageRequest = {
  url(): string;
};

export type Page = {
  close(): Promise<void>;
  isClosed(): boolean;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<PageResponse | null>;
  title(): Promise<string>;
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(expression: string, options?: { timeout?: number }): Promise<unknown>;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  unroute(pattern: string, handler?: RouteHandler): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
};

type LaunchFn = (userDataDir: string, options: { headless: boolean }) => Promise<BrowserContext>;

let launchPersistentContext: LaunchFn | null = null;

export function setLaunchFn(fn: LaunchFn | null): void {
  launchPersistentContext = fn;
}

async function getDefaultLaunchFn(): Promise<LaunchFn> {
  const pw = await import('playwright');
  return pw.chromium.launchPersistentContext.bind(pw.chromium);
}

function getProfileDir(): string {
  return join(getDataDir(), 'browser-profile');
}

class BrowserManager {
  private context: BrowserContext | null = null;
  private contextCreating: Promise<BrowserContext> | null = null;
  private pages = new Map<string, Page>();
  private snapshotMaps = new Map<string, Map<string, string>>();

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.contextCreating) return this.contextCreating;

    this.contextCreating = (async () => {
      const profileDir = getProfileDir();
      mkdirSync(profileDir, { recursive: true });

      const launch = launchPersistentContext ?? await getDefaultLaunchFn();
      const ctx = await launch(profileDir, { headless: true });
      log.info({ profileDir }, 'Browser context created');
      return ctx;
    })();

    try {
      this.context = await this.contextCreating;
      return this.context;
    } finally {
      this.contextCreating = null;
    }
  }

  async getOrCreateSessionPage(sessionId: string): Promise<Page> {
    const context = await this.ensureContext();

    const existing = this.pages.get(sessionId);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    // Clear stale snapshot mappings when replacing a closed page
    this.snapshotMaps.delete(sessionId);

    const page = await context.newPage();
    this.pages.set(sessionId, page);
    log.debug({ sessionId }, 'Session page created');
    return page;
  }

  async closeSessionPage(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(sessionId);
    this.snapshotMaps.delete(sessionId);
    log.debug({ sessionId }, 'Session page closed');
  }

  async closeAllPages(): Promise<void> {
    for (const [sessionId, page] of this.pages) {
      if (!page.isClosed()) {
        try {
          await page.close();
        } catch (err) {
          log.warn({ err, sessionId }, 'Failed to close page');
        }
      }
    }
    this.pages.clear();
    this.snapshotMaps.clear();

    if (this.context) {
      try {
        await this.context.close();
      } catch (err) {
        log.warn({ err }, 'Failed to close browser context');
      }
      this.context = null;
      log.info('Browser context closed');
    }
  }

  storeSnapshotMap(sessionId: string, map: Map<string, string>): void {
    this.snapshotMaps.set(sessionId, map);
  }

  clearSnapshotMap(sessionId: string): void {
    this.snapshotMaps.delete(sessionId);
  }

  resolveSnapshotSelector(sessionId: string, elementId: string): string | null {
    const map = this.snapshotMaps.get(sessionId);
    if (!map) return null;
    return map.get(elementId) ?? null;
  }

  hasContext(): boolean {
    return this.context !== null;
  }
}

export const browserManager = new BrowserManager();
