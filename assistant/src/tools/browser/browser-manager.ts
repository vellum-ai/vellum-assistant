import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getDataDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';
import { checkBrowserRuntime } from './runtime-check.js';
import { authSessionCache } from './auth-cache.js';
import type { ExtractedCredential } from './network-recording-types.js';
import { silentlyWithLog } from '../../util/silently.js';

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
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(expression: string, options?: { timeout?: number }): Promise<unknown>;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  unroute(pattern: string, handler?: RouteHandler): Promise<void>;
  bringToFront(): Promise<void>;
  screenshot(options?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
  mouse: {
    click(x: number, y: number, options?: { button?: string; clickCount?: number }): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  bringToFront(): Promise<void>;
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
  private _browserMode: 'headless' | 'cdp' = 'headless';
  private cdpUrl: string = 'http://localhost:9222';
  private cdpBrowser: unknown = null; // Store CDP browser reference separately
  private _browserLaunched = false; // true when browser was launched (vs connected via CDP)
  private browserCdpSession: CDPSession | null = null;
  private browserWindowId: number | null = null;
  private cdpRequestResolvers = new Map<string, (response: { success: boolean; declined?: boolean }) => void>();
  private interactiveModeSessions = new Set<string>();
  private handoffResolvers = new Map<string, () => void>();
  private sessionSenders = new Map<string, (msg: { type: string; sessionId: string }) => void>();

  get browserMode(): 'headless' | 'cdp' {
    return this._browserMode;
  }

  /** Whether page.route() is supported. False only for connectOverCDP browsers. */
  get supportsRouteInterception(): boolean {
    return this._browserMode !== 'cdp' || this._browserLaunched;
  }

  registerSender(sessionId: string, sendToClient: (msg: { type: string; sessionId: string }) => void): void {
    this.sessionSenders.set(sessionId, sendToClient);
  }

  unregisterSender(sessionId: string): void {
    this.sessionSenders.delete(sessionId);
  }

  setBrowserMode(mode: 'headless' | 'cdp', cdpUrl?: string): void {
    this._browserMode = mode;
    if (cdpUrl) this.cdpUrl = cdpUrl;
    log.info({ mode, cdpUrl: this.cdpUrl }, 'Browser mode set');
  }

  async detectCDP(url?: string): Promise<boolean> {
    const target = url || this.cdpUrl;
    try {
      const response = await fetch(`${target}/json/version`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Request Chrome restart from client via IPC. Returns true if client confirmed and CDP is now available.
   * The sendToClient callback sends the request, and resolveCDPResponse() is called when the response arrives.
   */
  async requestCDPFromClient(sessionId: string, sendToClient: (msg: { type: string; sessionId: string }) => void): Promise<boolean> {
    // Cancel any existing pending request for this session to avoid leaked promises
    const existing = this.cdpRequestResolvers.get(sessionId);
    if (existing) {
      existing({ success: false });
    }

    return new Promise<boolean>((resolve) => {
      const resolver = (response: { success: boolean; declined?: boolean }) => {
        clearTimeout(timer);
        // Only act if we're still the active resolver for this session
        if (this.cdpRequestResolvers.get(sessionId) === resolver) {
          this.cdpRequestResolvers.delete(sessionId);
        }
        resolve(response.success);
      };

      // Set a timeout in case the client never responds
      const timer = setTimeout(() => {
        if (this.cdpRequestResolvers.get(sessionId) === resolver) {
          this.cdpRequestResolvers.delete(sessionId);
        }
        resolve(false);
      }, 15_000);

      this.cdpRequestResolvers.set(sessionId, resolver);
      sendToClient({ type: 'browser_cdp_request', sessionId });
    });
  }

  /**
   * Called when a browser_cdp_response message arrives from the client.
   */
  resolveCDPResponse(sessionId: string, success: boolean, declined?: boolean): void {
    const resolver = this.cdpRequestResolvers.get(sessionId);
    if (resolver) {
      resolver({ success, declined });
    }
  }

  private async ensureContext(invokingSessionId?: string): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.contextCreating) return this.contextCreating;

    this.contextCreating = (async () => {
      // Deterministic test mode: when launch is injected via setLaunchFn,
      // bypass ambient CDP probing/negotiation and use the injected launcher.
      const hasInjectedLaunchFn = launchPersistentContext !== null;

      if (!hasInjectedLaunchFn) {
        // Try to detect or negotiate CDP before falling back to headless.
        // This auto-detects an existing Chrome with --remote-debugging-port,
        // or asks the client to restart Chrome with CDP enabled.
        let useCdp = this._browserMode === 'cdp';
        const sender = invokingSessionId ? this.sessionSenders.get(invokingSessionId) : undefined;
        if (!useCdp) {
          const cdpAvailable = await this.detectCDP();
          if (cdpAvailable) {
            useCdp = true;
          } else if (invokingSessionId && sender) {
            log.info({ sessionId: invokingSessionId }, 'Requesting CDP from client');
            const accepted = await this.requestCDPFromClient(invokingSessionId, sender);
            if (accepted) {
              const nowAvailable = await this.detectCDP();
              if (nowAvailable) {
                useCdp = true;
              } else {
                log.warn('Client accepted CDP request but CDP not detected');
              }
            } else {
              log.info('Client declined CDP request');
            }
          }
        }

        if (useCdp) {
          try {
            const pw = await import('playwright');
            const browser = await pw.chromium.connectOverCDP(this.cdpUrl, { timeout: 10_000 });
            this.cdpBrowser = browser;
            this._browserLaunched = false;
            const contexts = browser.contexts();
            const ctx = contexts[0] || await browser.newContext();
            this.setBrowserMode('cdp');
            await this.initBrowserCdpSession();
            log.info({ cdpUrl: this.cdpUrl }, 'Connected to Chrome via CDP');
            return ctx as unknown as BrowserContext;
          } catch (err) {
            log.warn({ err }, 'CDP connectOverCDP failed');
            this._browserMode = 'headless';
          }
        }

        // If a client is connected, launch headed Chromium (minimized) so the user
        // can interact directly when handoff triggers (e.g. CAPTCHAs).
        // The window stays offscreen until bringToFront() is called during handoff.
        const hasSender = !!(invokingSessionId && this.sessionSenders.get(invokingSessionId));
        if (hasSender && this._browserMode === 'headless') {
          try {
            const pw2 = await import('playwright');
            const headedBrowser = await pw2.chromium.launch({
              channel: 'chrome',
              headless: false,
              args: [
                '--window-position=-32000,-32000',
                '--window-size=1,1',
                '--disable-blink-features=AutomationControlled',
              ],
            });
            const ctx = headedBrowser.contexts()[0] || await headedBrowser.newContext();
            this.cdpBrowser = headedBrowser as unknown as typeof this.cdpBrowser;
            this._browserLaunched = true;
            this.setBrowserMode('cdp');
            await this.initBrowserCdpSession();
            log.info('Launched headed Chromium (minimized) for interactive handoff support');
            return ctx as unknown as BrowserContext;
          } catch (err2) {
            log.warn({ err: err2 }, 'Headed Chromium launch failed, falling back to headless');
          }
        }
      }

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
          this.browserCdpSession = null;
          this.browserWindowId = null;
          this.cdpBrowser = null;
          this._browserLaunched = false;
          // Resolve any pending handoffs before clearing state
          for (const resolver of this.handoffResolvers.values()) {
            resolver();
          }
          this.handoffResolvers.clear();
          this.interactiveModeSessions.clear();
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
    const context = await this.ensureContext(sessionId);

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

    // In CDP mode, keep the window minimized unless we're in an active handoff.
    if (this._browserMode === 'cdp' && !this.interactiveModeSessions.has(sessionId)) {
      await this.moveWindowOffscreen();
    }

    log.debug({ sessionId }, 'Session page created');
    return page;
  }

  async closeSessionPage(sessionId: string): Promise<void> {
    await this.stopScreencast(sessionId);
    // Clean up any pending handoff for this session
    this.interactiveModeSessions.delete(sessionId);
    const handoffResolver = this.handoffResolvers.get(sessionId);
    if (handoffResolver) {
      handoffResolver();
      this.handoffResolvers.delete(sessionId);
    }
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

    // Detach browser-level CDP session used for window management
    if (this.browserCdpSession) {
      try {
        await this.browserCdpSession.detach();
      } catch (e) { log.debug({ err: e }, 'CDP session detach failed during shutdown'); }
      this.browserCdpSession = null;
      this.browserWindowId = null;
    }

    // Close or disconnect CDP browser connection if present
    if (this.cdpBrowser) {
      const b = this.cdpBrowser as { close?: () => Promise<void>; disconnect?: () => Promise<void> };
      const wasLaunched = this._browserLaunched;
      this.cdpBrowser = null;
      this._browserLaunched = false;
      try {
        if (wasLaunched) {
          // Launched browsers must be closed to terminate the process
          await b.close?.();
        } else {
          // CDP-connected browsers should be disconnected, not closed
          await b.disconnect?.();
        }
      } catch (err) {
        log.warn({ err }, 'Failed to close/disconnect CDP browser');
      }
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
      silentlyWithLog(cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }), 'screencast frame ack');
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 960,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(sessionId: string): Promise<void> {
    const cdp = this.cdpSessions.get(sessionId);
    if (cdp) {
      try {
        await cdp.send('Page.stopScreencast');
        await cdp.detach();
      } catch (e) { log.debug({ err: e }, 'Screencast stop / CDP detach failed during cleanup'); }
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

  /**
   * Create a browser-level CDP session and discover the window ID.
   * Called once after browser launch/connect so moveWindowOffscreen/Onscreen can work.
   */
  private async initBrowserCdpSession(): Promise<void> {
    if (!this.cdpBrowser) return;
    try {
      const browser = this.cdpBrowser as { newBrowserCDPSession?: () => Promise<CDPSession> };
      if (typeof browser.newBrowserCDPSession !== 'function') return;

      this.browserCdpSession = await browser.newBrowserCDPSession();
      this.browserWindowId = null;
      await this.ensureBrowserWindowId();
    } catch (err) {
      log.warn({ err }, 'Failed to init browser CDP session');
    }
  }

  private async ensureBrowserWindowId(): Promise<number | null> {
    if (!this.browserCdpSession) return null;
    if (this.browserWindowId != null) return this.browserWindowId;
    try {
      const targets = await this.browserCdpSession.send('Target.getTargets') as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      const pageTarget = targets.targetInfos.find((t: { type: string }) => t.type === 'page');
      if (!pageTarget) return null;
      const result = await this.browserCdpSession.send('Browser.getWindowForTarget', {
        targetId: pageTarget.targetId,
      }) as { windowId: number };
      this.browserWindowId = result.windowId;
      log.debug({ windowId: this.browserWindowId }, 'Got browser window ID via CDP');
      return this.browserWindowId;
    } catch (err) {
      log.warn({ err }, 'Failed to resolve browser window ID');
      return null;
    }
  }

  /**
   * Hide the browser window during non-handoff automation to avoid focus theft.
   */
  async moveWindowOffscreen(): Promise<void> {
    if (!this.browserCdpSession) return;
    const windowId = await this.ensureBrowserWindowId();
    if (windowId == null) return;
    try {
      await this.browserCdpSession.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      log.debug('moveWindowOffscreen: minimized browser window via CDP');
    } catch (err) {
      log.warn({ err }, 'moveWindowOffscreen: minimize failed, attempting offscreen bounds');
      try {
        await this.browserCdpSession.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: -32000, top: -32000, windowState: 'normal' },
        });
      } catch (boundsErr) {
        log.warn({ err: boundsErr }, 'moveWindowOffscreen: offscreen bounds failed');
      }
    }
  }

  /**
   * Move the browser window onscreen and resize it for user interaction.
   */
  async moveWindowOnscreen(): Promise<void> {
    if (!this.browserCdpSession) return;
    const windowId = await this.ensureBrowserWindowId();
    if (windowId == null) return;
    try {
      await this.browserCdpSession.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 100, top: 100, width: 1280, height: 960, windowState: 'normal' },
      });
      log.debug('moveWindowOnscreen: moved window onscreen via CDP');
    } catch (err) {
      log.warn({ err }, 'moveWindowOnscreen: CDP setWindowBounds failed');
    }
  }

  isInteractive(sessionId: string): boolean {
    return this.interactiveModeSessions.has(sessionId);
  }

  setInteractiveMode(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.interactiveModeSessions.add(sessionId);
    } else {
      this.interactiveModeSessions.delete(sessionId);
      const resolver = this.handoffResolvers.get(sessionId);
      if (resolver) {
        resolver();
        this.handoffResolvers.delete(sessionId);
      }
    }
  }

  async waitForHandoffComplete(sessionId: string, timeoutMs: number = 300_000): Promise<void> {
    if (!this.interactiveModeSessions.has(sessionId)) return;

    // Cancel any existing pending handoff for this session
    const existing = this.handoffResolvers.get(sessionId);
    if (existing) {
      existing();
    }

    return new Promise<void>((resolve) => {
      const resolver = () => {
        clearTimeout(timer);
        if (this.handoffResolvers.get(sessionId) === resolver) {
          this.handoffResolvers.delete(sessionId);
        }
        resolve();
      };

      const timer = setTimeout(() => {
        if (this.handoffResolvers.get(sessionId) === resolver) {
          this.handoffResolvers.delete(sessionId);
        }
        this.interactiveModeSessions.delete(sessionId);
        resolve();
      }, timeoutMs);

      this.handoffResolvers.set(sessionId, resolver);
    });
  }

  /**
   * Get the raw Playwright page for a session (for CDP session creation).
   * Used by NetworkRecorder to create its own CDP session.
   */
  getRawPage(sessionId: string): unknown | undefined {
    return this.rawPages.get(sessionId);
  }

  /**
   * Get any available raw page (for network recording when we don't care which page).
   */
  getAnyRawPage(): unknown | undefined {
    for (const page of this.rawPages.values()) {
      return page;
    }
    return undefined;
  }

  /**
   * Extract cookies from the browser via CDP, optionally filtered by domain.
   */
  async extractCookies(domain?: string): Promise<ExtractedCredential[]> {
    if (!this.browserCdpSession) return [];
    try {
      const result = await this.browserCdpSession.send('Network.getAllCookies') as {
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          httpOnly: boolean;
          secure: boolean;
          expires: number;
        }>;
      };

      let cookies = result.cookies ?? [];
      if (domain) {
        cookies = cookies.filter(c =>
          c.domain === domain ||
          c.domain === `.${domain}` ||
          c.domain.endsWith(`.${domain}`),
        );
      }

      return cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expires: c.expires > 0 ? c.expires : undefined,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to extract cookies via CDP');
      return [];
    }
  }

  hasContext(): boolean {
    return this.context !== null;
  }
}

export const browserManager = new BrowserManager();

export function isAuthenticatedForDomain(domain: string): boolean {
  return authSessionCache.isAuthenticated(domain);
}
