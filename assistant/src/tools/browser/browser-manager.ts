import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDataDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';
import { checkBrowserRuntime } from './runtime-check.js';
import { authSessionCache } from './auth-cache.js';

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
  screenshot(options?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
};

type ScreencastFrameMetadata = {
  offsetTop: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp: number;
};

type CDPSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  detach(): Promise<void>;
};

type RawPlaywrightPage = {
  context(): { newCDPSession(page: unknown): Promise<CDPSession> };
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
  private contextCloseHandler: ((...args: unknown[]) => void) | null = null;
  private pages = new Map<string, Page>();
  private rawPages = new Map<string, unknown>();
  private cdpSessions = new Map<string, CDPSession>();
  private screencastCallbacks = new Map<string, (frame: { data: string; metadata: ScreencastFrameMetadata }) => void>();
  private snapshotMaps = new Map<string, Map<string, string>>();

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.contextCreating) return this.contextCreating;

    this.contextCreating = (async () => {
      const profileDir = getProfileDir();
      mkdirSync(profileDir, { recursive: true });

      // Initialize auth session cache alongside browser context
      await authSessionCache.load();

      // Auto-install Chromium if missing
      if (!launchPersistentContext) {
        const status = await checkBrowserRuntime();
        if (status.playwrightAvailable && !status.chromiumInstalled) {
          log.info('Chromium not installed, installing via playwright...');
          const proc = Bun.spawn(['bunx', 'playwright', 'install', 'chromium'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const timeoutMs = 120_000;
          let timer: ReturnType<typeof setTimeout>;
          const exitCode = await Promise.race([
            proc.exited.finally(() => clearTimeout(timer)),
            new Promise<never>((_, reject) =>
              timer = setTimeout(() => {
                proc.kill();
                reject(new Error(`Chromium install timed out after ${timeoutMs / 1000}s`));
              }, timeoutMs),
            ),
          ]);
          if (exitCode === 0) {
            log.info('Chromium installed successfully');
          } else {
            const stderr = await new Response(proc.stderr).text();
            const msg = stderr.trim() || `exited with code ${exitCode}`;
            throw new Error(`Failed to install Chromium: ${msg}`);
          }
        }
      }

      const launch = launchPersistentContext ?? await getDefaultLaunchFn();
      const ctx = await launch(profileDir, { headless: true });
      log.info({ profileDir }, 'Browser context created');
      return ctx;
    })();

    try {
      this.context = await this.contextCreating;

      // Listen for browser disconnection so we can reset state
      // instead of leaving a stale context reference.
      const rawCtx = this.context as unknown as {
        on?: (event: string, handler: (...args: unknown[]) => void) => void;
        off?: (event: string, handler: (...args: unknown[]) => void) => void;
      };
      if (typeof rawCtx.on === 'function') {
        this.contextCloseHandler = () => {
          log.warn('Browser context closed unexpectedly, resetting state');
          this.context = null;
          this.contextCloseHandler = null;
          this.pages.clear();
          this.rawPages.clear();
          this.cdpSessions.clear();
          this.screencastCallbacks.clear();
          this.snapshotMaps.clear();
        };
        rawCtx.on('close', this.contextCloseHandler);
      }

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

    // Clear stale snapshot mappings and CDP state when replacing a closed page
    this.snapshotMaps.delete(sessionId);
    await this.stopScreencast(sessionId);

    const page = await context.newPage();
    this.pages.set(sessionId, page);
    this.rawPages.set(sessionId, page);
    log.debug({ sessionId }, 'Session page created');
    return page;
  }

  async closeSessionPage(sessionId: string): Promise<void> {
    await this.stopScreencast(sessionId);
    const page = this.pages.get(sessionId);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(sessionId);
    this.rawPages.delete(sessionId);
    this.snapshotMaps.delete(sessionId);
    log.debug({ sessionId }, 'Session page closed');
  }

  async closeAllPages(): Promise<void> {
    // Stop all screencasts first
    for (const sessionId of this.cdpSessions.keys()) {
      try {
        await this.stopScreencast(sessionId);
      } catch (err) {
        log.warn({ err, sessionId }, 'Failed to stop screencast');
      }
    }

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
    this.rawPages.clear();
    this.snapshotMaps.clear();

    if (this.context) {
      // Remove the close listener before intentional close to avoid
      // the handler firing and clearing state we're already cleaning up.
      if (this.contextCloseHandler) {
        const rawCtx = this.context as unknown as { off?: (event: string, handler: (...args: unknown[]) => void) => void };
        if (typeof rawCtx.off === 'function') {
          rawCtx.off('close', this.contextCloseHandler);
        }
        this.contextCloseHandler = null;
      }
      try {
        await this.context.close();
      } catch (err) {
        log.warn({ err }, 'Failed to close browser context');
      }
      this.context = null;
      log.info('Browser context closed');
    }
  }

  async startScreencast(sessionId: string, onFrame: (frame: { data: string; metadata: ScreencastFrameMetadata }) => void): Promise<void> {
    const rawPage = this.rawPages.get(sessionId) as RawPlaywrightPage | undefined;
    if (!rawPage) throw new Error('No page for session');

    // Stop any existing screencast before creating a new CDP session
    await this.stopScreencast(sessionId);

    const cdp = await rawPage.context().newCDPSession(rawPage);
    this.cdpSessions.set(sessionId, cdp);
    this.screencastCallbacks.set(sessionId, onFrame);

    cdp.on('Page.screencastFrame', (params) => {
      onFrame({ data: params.data as string, metadata: params.metadata as ScreencastFrameMetadata });
      cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 800,
      maxHeight: 600,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(sessionId: string): Promise<void> {
    const cdp = this.cdpSessions.get(sessionId);
    if (cdp) {
      try {
        await cdp.send('Page.stopScreencast');
        await cdp.detach();
      } catch {}
      this.cdpSessions.delete(sessionId);
      this.screencastCallbacks.delete(sessionId);
    }
  }

  isScreencasting(sessionId: string): boolean {
    return this.cdpSessions.has(sessionId);
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

export function isAuthenticatedForDomain(domain: string): boolean {
  return authSessionCache.isAuthenticated(domain);
}
