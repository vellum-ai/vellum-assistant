import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { getLogger } from "../../util/logger.js";
import { getDataDir } from "../../util/platform.js";
import { authSessionCache } from "./auth-cache.js";
import type { CdpClientKind } from "./cdp-client/types.js";
import type { ExtractedCredential } from "./network-recording-types.js";
import { importPlaywright } from "./runtime-check.js";

const log = getLogger("browser-manager");

/**
 * Well-known paths where Google Chrome is installed on each platform.
 * Returns the first path that exists on disk, or null if none found.
 */
function findSystemChrome(): string | null {
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    candidates.push(
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    );
  } else {
    // Linux
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Returns true when the host has a GUI capable of displaying a browser window.
 * macOS and Windows always have a display; Linux requires DISPLAY or WAYLAND_DISPLAY.
 */
function canDisplayGui(): boolean {
  if (process.platform === "darwin" || process.platform === "win32")
    return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function getDownloadsDir(): string {
  const dir = join(getDataDir(), "browser-downloads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeDownloadFilename(filename: string): string {
  const leaf = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const stripped = leaf.replaceAll("\0", "").trim();
  const safe = stripped.length > 0 ? stripped : "download";
  return safe === "." || safe === ".." ? "download" : safe;
}

/** Wraps a promise with a timeout to prevent indefinite hangs. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type DownloadInfo = { path: string; filename: string };

type BrowserContext = {
  newPage(): Promise<Page>;
  pages?(): Page[];
  close(): Promise<void>;
};

export type PageResponse = {
  status(): number | null;
  url(): string;
};

export type RouteHandler = (
  route: PageRoute,
  request: PageRequest,
) => Promise<void> | void;

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
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<PageResponse | null>;
  title(): Promise<string>;
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(
    selector: string,
    value: string,
    options?: { timeout?: number },
  ): Promise<void>;
  press(
    selector: string,
    key: string,
    options?: { timeout?: number },
  ): Promise<void>;
  selectOption(
    selector: string,
    values: Record<string, string | number>,
    options?: { timeout?: number },
  ): Promise<string[]>;
  hover(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
  waitForFunction(
    expression: string,
    options?: { timeout?: number },
  ): Promise<unknown>;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  unroute(pattern: string, handler?: RouteHandler): Promise<void>;
  bringToFront(): Promise<void>;
  screenshot(options?: {
    type?: string;
    quality?: number;
    fullPage?: boolean;
  }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
  mouse: {
    click(
      x: number,
      y: number,
      options?: { button?: string; clickCount?: number },
    ): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  on(event: string, handler: (...args: unknown[]) => void): void;
};

type CDPSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  detach(): Promise<void>;
};

type RawPlaywrightPage = {
  context(): { newCDPSession(page: unknown): Promise<CDPSession> };
};

type LaunchFn = (
  userDataDir: string,
  options: { headless: boolean },
) => Promise<BrowserContext>;

let launchPersistentContext: LaunchFn | null = null;

export function setLaunchFn(fn: LaunchFn | null): void {
  launchPersistentContext = fn;
}

function getProfileDir(): string {
  return join(getDataDir(), "browser-profile");
}

class BrowserManager {
  private context: BrowserContext | null = null;
  private contextCreating: Promise<BrowserContext> | null = null;
  private contextCloseHandler: ((...args: unknown[]) => void) | null = null;
  private pages = new Map<string, Page>();
  private rawPages = new Map<string, unknown>();
  private cdpSessions = new Map<string, CDPSession>();
  /**
   * CDP backendNodeId lookup per conversation, populated by the
   * AX-tree-based `executeBrowserSnapshot`. Click/type/hover/etc. tools
   * resolve an element_id against this map and talk to CDP with the
   * resulting backendNodeId.
   */
  private snapshotBackendNodeMaps = new Map<string, Map<string, number>>();
  /**
   * The CDP backend kind that a conversation resolved to on an earlier
   * tool call. When a subsequent browser_* call arrives with
   * `browser_mode: "auto"`, the factory is pinned to this kind so
   * navigate and screenshot cannot land on different Chromes within
   * the same conversation. Explicit non-auto modes overwrite the entry.
   * Cleared when the conversation's page is closed or all pages are
   * closed.
   */
  private preferredBackendKinds = new Map<string, CdpClientKind>();
  private browserCdpSession: CDPSession | null = null;
  private browserWindowId: number | null = null;
  private interactiveModeSessions = new Set<string>();
  private handoffResolvers = new Map<string, () => void>();
  private downloads = new Map<string, DownloadInfo[]>();
  private pendingDownloads = new Map<
    string,
    { resolve: (info: DownloadInfo) => void; reject: (err: Error) => void }[]
  >();

  /** Whether page.route() is supported. Always true for launched browsers. */
  get supportsRouteInterception(): boolean {
    return true;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.contextCreating) return this.contextCreating;

    this.contextCreating = (async () => {
      await authSessionCache.load();

      // Ensure Playwright's bundled Chrome for Testing is installed.
      // Accepts the playwright module so it can be called from different scopes.
      const ensureChromeForTesting = async (
        pw: Awaited<ReturnType<typeof importPlaywright>>,
      ) => {
        let chromiumInstalled = false;
        try {
          const execPath = pw.chromium.executablePath();
          chromiumInstalled = existsSync(execPath);
        } catch {
          // executablePath() may throw if registry is missing
        }

        if (!chromiumInstalled) {
          log.info("Chromium not installed, installing via playwright...");
          const proc = Bun.spawn(
            ["bunx", "playwright", "install", "--with-deps", "chromium"],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const timeoutMs = 300_000;
          let timer: ReturnType<typeof setTimeout>;
          const exitCode = await Promise.race([
            proc.exited.finally(() => clearTimeout(timer)),
            new Promise<never>(
              (_, reject) =>
                (timer = setTimeout(() => {
                  proc.kill();
                  reject(
                    new Error(
                      `Chromium install timed out after ${timeoutMs / 1000}s`,
                    ),
                  );
                }, timeoutMs)),
            ),
          ]);
          if (exitCode === 0) {
            log.info("Chromium installed successfully");
          } else {
            const stderr = await new Response(proc.stderr).text();
            const msg = stderr.trim() || `exited with code ${exitCode}`;
            throw new Error(`Failed to install Chromium: ${msg}`);
          }
        }
      };

      // Resolve launch function: use injected test launcher or resolve
      // playwright (may install at runtime in compiled binaries).
      let launch: LaunchFn;
      if (launchPersistentContext) {
        launch = launchPersistentContext;
      } else {
        const pw = await importPlaywright();

        // Prefer a locally-installed Google Chrome over Chrome for Testing.
        // If system Chrome exists but fails to launch, fall back to the
        // bundled Chrome for Testing so browser features remain available.
        const systemChrome = findSystemChrome();

        if (systemChrome) {
          log.info({ path: systemChrome }, "Using system Chrome installation");
          launch = (userDataDir, options) =>
            pw.chromium.launchPersistentContext(userDataDir, {
              ...options,
              executablePath: systemChrome,
            });
        } else {
          await ensureChromeForTesting(pw);
          launch = pw.chromium.launchPersistentContext.bind(pw.chromium);
        }
      }

      const profileDir = getProfileDir();
      mkdirSync(profileDir, { recursive: true });
      const headless = !canDisplayGui();

      let ctx: BrowserContext;
      try {
        ctx = await launch(profileDir, { headless });
      } catch (err) {
        // If system Chrome was selected but failed, fall back to Chrome for Testing
        if (findSystemChrome() && !launchPersistentContext) {
          log.warn(
            { err },
            "System Chrome launch failed, falling back to Chrome for Testing",
          );
          const pw = await importPlaywright();
          await ensureChromeForTesting(pw);
          ctx = await pw.chromium.launchPersistentContext(profileDir, {
            headless,
          });
        } else {
          throw err;
        }
      }
      log.info(
        { profileDir, headless },
        headless
          ? "Browser context created (headless)"
          : "Browser context created (visible)",
      );
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
      if (typeof rawCtx.on === "function") {
        this.contextCloseHandler = () => {
          log.warn("Browser context closed unexpectedly, resetting state");
          this.context = null;
          this.contextCloseHandler = null;
          this.browserCdpSession = null;
          this.browserWindowId = null;
          // Resolve any pending handoffs before clearing state
          for (const resolver of this.handoffResolvers.values()) {
            resolver();
          }
          this.handoffResolvers.clear();
          this.interactiveModeSessions.clear();
          this.pages.clear();
          this.rawPages.clear();
          this.cdpSessions.clear();

          this.snapshotBackendNodeMaps.clear();
          this.downloads.clear();
          for (const pending of this.pendingDownloads.values()) {
            for (const waiter of pending)
              waiter.reject(new Error("Browser closed"));
          }
          this.pendingDownloads.clear();
        };
        rawCtx.on("close", this.contextCloseHandler);
      }

      return this.context;
    } finally {
      this.contextCreating = null;
    }
  }

  async getOrCreateSessionPage(conversationId: string): Promise<Page> {
    const context = await this.ensureContext();

    const existing = this.pages.get(conversationId);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    // Clear stale snapshot mappings and CDP state when replacing a closed page
    this.snapshotBackendNodeMaps.delete(conversationId);
    await this.stopScreencast(conversationId);

    const page = await context.newPage();
    this.pages.set(conversationId, page);
    this.rawPages.set(conversationId, page);

    // Track downloads for this page
    this.setupDownloadTracking(conversationId, page);

    // Create a page-level CDP session for window positioning.
    // Browser domain commands (setWindowBounds, getWindowForTarget) are accessible
    // from page-level CDP sessions.
    if (!this.browserCdpSession) {
      try {
        const rawPage = page as unknown as RawPlaywrightPage;
        this.browserCdpSession = await rawPage.context().newCDPSession(rawPage);
        await this.ensureBrowserWindowId();
      } catch (err) {
        log.warn(
          { err },
          "Failed to create CDP session for window positioning",
        );
      }
    }

    // Position the browser window so the user can watch.
    if (
      this.browserCdpSession &&
      !this.interactiveModeSessions.has(conversationId)
    ) {
      await this.positionWindowSidebar();
    }

    log.debug({ conversationId }, "Conversation page created");
    return page;
  }

  async closeSessionPage(conversationId: string): Promise<void> {
    await this.stopScreencast(conversationId);
    // Clean up any pending handoff for this session
    this.interactiveModeSessions.delete(conversationId);
    const handoffResolver = this.handoffResolvers.get(conversationId);
    if (handoffResolver) {
      handoffResolver();
      this.handoffResolvers.delete(conversationId);
    }
    const page = this.pages.get(conversationId);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(conversationId);
    this.rawPages.delete(conversationId);
    this.snapshotBackendNodeMaps.delete(conversationId);
    this.preferredBackendKinds.delete(conversationId);
    this.downloads.delete(conversationId);
    // Reject any pending download waiters
    const pending = this.pendingDownloads.get(conversationId);
    if (pending) {
      for (const waiter of pending)
        waiter.reject(new Error("Browser page closed"));
      this.pendingDownloads.delete(conversationId);
    }
    log.debug({ conversationId }, "Conversation page closed");
  }

  async closeAllPages(): Promise<void> {
    // Stop all screencasts first
    for (const conversationId of this.cdpSessions.keys()) {
      try {
        await this.stopScreencast(conversationId);
      } catch (err) {
        log.warn({ err, conversationId }, "Failed to stop screencast");
      }
    }

    for (const [conversationId, page] of this.pages) {
      if (!page.isClosed()) {
        try {
          await page.close();
        } catch (err) {
          log.warn({ err, conversationId }, "Failed to close page");
        }
      }
    }
    this.pages.clear();
    this.rawPages.clear();
    this.snapshotBackendNodeMaps.clear();
    this.preferredBackendKinds.clear();
    this.downloads.clear();
    for (const pending of this.pendingDownloads.values()) {
      for (const waiter of pending) waiter.reject(new Error("Browser closed"));
    }
    this.pendingDownloads.clear();

    if (this.context) {
      // Remove the close listener before intentional close to avoid
      // the handler firing and clearing state we're already cleaning up.
      if (this.contextCloseHandler) {
        const rawCtx = this.context as unknown as {
          off?: (event: string, handler: (...args: unknown[]) => void) => void;
        };
        if (typeof rawCtx.off === "function") {
          rawCtx.off("close", this.contextCloseHandler);
        }
        this.contextCloseHandler = null;
      }
      try {
        await this.context.close();
      } catch (err) {
        log.warn({ err }, "Failed to close browser context");
      }
      this.context = null;
      log.info("Browser context closed");
    }

    // Detach browser-level CDP session used for window management
    if (this.browserCdpSession) {
      try {
        await this.browserCdpSession.detach();
      } catch (e) {
        log.debug({ err: e }, "CDP session detach failed during shutdown");
      }
      this.browserCdpSession = null;
      this.browserWindowId = null;
    }
  }

  async stopScreencast(conversationId: string): Promise<void> {
    const cdp = this.cdpSessions.get(conversationId);
    if (cdp) {
      try {
        await cdp.send("Page.stopScreencast");
        await cdp.detach();
      } catch (e) {
        log.debug(
          { err: e },
          "Screencast stop / CDP detach failed during cleanup",
        );
      }
      this.cdpSessions.delete(conversationId);
    }
  }

  /**
   * Look up the backend kind this conversation has been using. Returns
   * `null` before the first successful CDP send or after an explicit
   * teardown. Callers should pass the result to the factory as a
   * pinned mode so `auto`-mode calls stay consistent across tool
   * invocations.
   */
  getPreferredBackendKind(conversationId: string): CdpClientKind | null {
    return this.preferredBackendKinds.get(conversationId) ?? null;
  }

  /**
   * Record the backend kind that a tool call resolved to. Overwrites
   * any prior value so an explicit `browser_mode` override on one call
   * becomes the default for subsequent `auto`-mode calls.
   */
  setPreferredBackendKind(conversationId: string, kind: CdpClientKind): void {
    this.preferredBackendKinds.set(conversationId, kind);
  }

  /**
   * Drop the remembered backend kind for a conversation. Called on
   * explicit teardown (browser_close, closeAllPages) so the next call
   * re-runs the auto priority list.
   */
  clearPreferredBackendKind(conversationId: string): void {
    this.preferredBackendKinds.delete(conversationId);
  }

  /**
   * Store the backendNodeId lookup produced by the AX-tree-based
   * `executeBrowserSnapshot`. Callers overwrite any prior map for the
   * conversation so each snapshot fully supersedes the previous one.
   */
  storeSnapshotBackendNodeMap(
    conversationId: string,
    map: Map<string, number>,
  ): void {
    this.snapshotBackendNodeMaps.set(conversationId, map);
  }

  /**
   * Drop the backendNodeId lookup for a conversation so stale element
   * IDs from a previous snapshot cannot resolve after a navigation or
   * page close.
   */
  clearSnapshotBackendNodeMap(conversationId: string): void {
    this.snapshotBackendNodeMaps.delete(conversationId);
  }

  /**
   * Look up the CDP backendNodeId for an element id produced by the
   * most recent AX-tree snapshot. Returns `null` if no snapshot has
   * been taken or the id is unknown.
   */
  resolveSnapshotBackendNodeId(
    conversationId: string,
    elementId: string,
  ): number | null {
    const map = this.snapshotBackendNodeMaps.get(conversationId);
    if (!map) return null;
    return map.get(elementId) ?? null;
  }

  private async ensureBrowserWindowId(): Promise<number | null> {
    if (!this.browserCdpSession) return null;
    if (this.browserWindowId != null) return this.browserWindowId;
    try {
      const targets = (await this.browserCdpSession.send(
        "Target.getTargets",
      )) as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      const pageTarget = targets.targetInfos.find(
        (t: { type: string }) => t.type === "page",
      );
      if (!pageTarget) return null;
      const result = (await this.browserCdpSession.send(
        "Browser.getWindowForTarget",
        {
          targetId: pageTarget.targetId,
        },
      )) as { windowId: number };
      this.browserWindowId = result.windowId;
      log.debug(
        { windowId: this.browserWindowId },
        "Got browser window ID via CDP",
      );
      return this.browserWindowId;
    } catch (err) {
      log.warn({ err }, "Failed to resolve browser window ID");
      return null;
    }
  }

  /**
   * Position the browser window small on the right side of the screen so the
   * user can watch automation while still seeing assistant messages on the left.
   */
  async positionWindowSidebar(): Promise<void> {
    if (!this.browserCdpSession) return;
    const windowId = await this.ensureBrowserWindowId();
    if (windowId == null) return;
    try {
      await this.browserCdpSession.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 480,
          top: 40,
          width: 940,
          height: 700,
          windowState: "normal",
        },
      });
      log.debug("positionWindowSidebar: placed browser window in top-right");
    } catch (err) {
      log.warn({ err }, "positionWindowSidebar: failed to position window");
      // CDP session may be stale (e.g. page closed) - clear it so it gets recreated
      this.browserCdpSession = null;
      this.browserWindowId = null;
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
      await this.browserCdpSession.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 200,
          top: 40,
          width: 1100,
          height: 820,
          windowState: "normal",
        },
      });
      log.debug("moveWindowOnscreen: moved window onscreen via CDP");
    } catch (err) {
      log.warn({ err }, "moveWindowOnscreen: CDP setWindowBounds failed");
    }
  }

  isInteractive(conversationId: string): boolean {
    return this.interactiveModeSessions.has(conversationId);
  }

  setInteractiveMode(conversationId: string, enabled: boolean): void {
    if (enabled) {
      this.interactiveModeSessions.add(conversationId);
    } else {
      this.interactiveModeSessions.delete(conversationId);
      const resolver = this.handoffResolvers.get(conversationId);
      if (resolver) {
        resolver();
        this.handoffResolvers.delete(conversationId);
      }
    }
  }

  async waitForHandoffComplete(
    conversationId: string,
    timeoutMs: number = 300_000,
  ): Promise<void> {
    if (!this.interactiveModeSessions.has(conversationId)) return;

    // Cancel any existing pending handoff for this session
    const existing = this.handoffResolvers.get(conversationId);
    if (existing) {
      existing();
    }

    // Capture the initial URL so we can auto-detect page changes
    const page = this.pages.get(conversationId);
    const initialUrl = page && !page.isClosed() ? page.url() : null;

    return new Promise<void>((resolve) => {
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const resolver = () => {
        clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (this.handoffResolvers.get(conversationId) === resolver) {
          this.handoffResolvers.delete(conversationId);
        }
        resolve();
      };

      const timer = setTimeout(() => {
        if (pollTimer) clearInterval(pollTimer);
        if (this.handoffResolvers.get(conversationId) === resolver) {
          this.handoffResolvers.delete(conversationId);
        }
        this.interactiveModeSessions.delete(conversationId);
        resolve();
      }, timeoutMs);

      this.handoffResolvers.set(conversationId, resolver);

      // Poll for URL changes - auto-resolve when the page navigates
      // (e.g., CAPTCHA solved, login redirect)
      if (initialUrl && page) {
        pollTimer = setInterval(() => {
          try {
            if (page.isClosed()) {
              this.interactiveModeSessions.delete(conversationId);
              resolver();
              return;
            }
            const currentUrl = page.url();
            if (currentUrl !== initialUrl) {
              log.info(
                { conversationId, from: initialUrl, to: currentUrl },
                "Handoff auto-resolved: URL changed",
              );
              this.interactiveModeSessions.delete(conversationId);
              resolver();
            }
          } catch {
            // Page may have been closed - resolve gracefully
            this.interactiveModeSessions.delete(conversationId);
            resolver();
          }
        }, 2000);
      }
    });
  }

  /**
   * Get the raw Playwright page for a session (for CDP session creation).
   * Used by NetworkRecorder to create its own CDP session.
   */
  getRawPage(conversationId: string): unknown | undefined {
    return this.rawPages.get(conversationId);
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
      const result = (await this.browserCdpSession.send(
        "Network.getAllCookies",
      )) as {
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
        cookies = cookies.filter(
          (c) =>
            c.domain === domain ||
            c.domain === `.${domain}` ||
            c.domain.endsWith(`.${domain}`),
        );
      }

      return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        expires: c.expires > 0 ? c.expires : undefined,
      }));
    } catch (err) {
      log.warn({ err }, "Failed to extract cookies via CDP");
      return [];
    }
  }

  private setupDownloadTracking(conversationId: string, page: Page): void {
    page.on("download", async (download: unknown) => {
      const dl = download as {
        suggestedFilename(): string;
        path(): Promise<string | null>;
        saveAs(path: string): Promise<void>;
        failure(): Promise<string | null>;
      };
      try {
        const filename = sanitizeDownloadFilename(dl.suggestedFilename());
        const downloadsDir = getDownloadsDir();
        const destPath = resolve(downloadsDir, `${Date.now()}-${filename}`);
        const relPath = relative(resolve(downloadsDir), destPath);
        if (relPath.startsWith("..") || isAbsolute(relPath)) {
          throw new Error("Resolved download path escaped downloads directory");
        }
        await withTimeout(dl.saveAs(destPath), 120_000, "Download save");
        const info: DownloadInfo = { path: destPath, filename };

        // Resolve a pending waiter if one exists, otherwise store for later retrieval
        const pending = this.pendingDownloads.get(conversationId);
        if (pending && pending.length > 0) {
          const waiter = pending.shift()!;
          waiter.resolve(info);
          if (pending.length === 0)
            this.pendingDownloads.delete(conversationId);
        } else {
          const list = this.downloads.get(conversationId) ?? [];
          list.push(info);
          this.downloads.set(conversationId, list);
        }

        log.info(
          { conversationId, filename, path: destPath },
          "Download completed",
        );
      } catch (err) {
        const failure = await withTimeout(
          dl.failure(),
          5_000,
          "Download failure check",
        ).catch(() => null);
        log.warn({ err, failure, conversationId }, "Download failed");

        // Reject any pending waiters
        const pending = this.pendingDownloads.get(conversationId);
        if (pending && pending.length > 0) {
          const waiter = pending.shift()!;
          waiter.reject(
            new Error(`Download failed: ${failure ?? String(err)}`),
          );
          if (pending.length === 0)
            this.pendingDownloads.delete(conversationId);
        }
      }
    });
  }

  getLastDownload(conversationId: string): DownloadInfo | null {
    const list = this.downloads.get(conversationId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  waitForDownload(
    conversationId: string,
    timeoutMs: number = 30_000,
  ): Promise<DownloadInfo> {
    // Check if an unconsumed download already completed for this session
    const existing = this.downloads.get(conversationId);
    if (existing && existing.length > 0) {
      const info = existing.shift()!;
      if (existing.length === 0) this.downloads.delete(conversationId);
      return Promise.resolve(info);
    }

    return new Promise<DownloadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the pending list
        const pending = this.pendingDownloads.get(conversationId);
        if (pending) {
          const idx = pending.findIndex((w) => w.resolve === wrappedResolve);
          if (idx >= 0) pending.splice(idx, 1);
          if (pending.length === 0)
            this.pendingDownloads.delete(conversationId);
        }
        reject(new Error(`Download timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const wrappedResolve = (info: DownloadInfo) => {
        clearTimeout(timer);
        resolve(info);
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      const pending = this.pendingDownloads.get(conversationId) ?? [];
      pending.push({ resolve: wrappedResolve, reject: wrappedReject });
      this.pendingDownloads.set(conversationId, pending);
    });
  }

  hasContext(): boolean {
    return this.context != null;
  }
}

export const browserManager = new BrowserManager();
