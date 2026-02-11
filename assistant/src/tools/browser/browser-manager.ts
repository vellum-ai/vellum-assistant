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

export type Page = {
  close(): Promise<void>;
  isClosed(): boolean;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<PageResponse | null>;
  title(): Promise<string>;
  url(): string;
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
  private pages = new Map<string, Page>();
  private snapshotMaps = new Map<string, Map<string, string>>();

  async getOrCreateSessionPage(sessionId: string): Promise<Page> {
    if (!this.context) {
      const profileDir = getProfileDir();
      mkdirSync(profileDir, { recursive: true });

      const launch = launchPersistentContext ?? await getDefaultLaunchFn();
      this.context = await launch(profileDir, { headless: true });
      log.info({ profileDir }, 'Browser context created');
    }

    const existing = this.pages.get(sessionId);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    const page = await this.context.newPage();
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
