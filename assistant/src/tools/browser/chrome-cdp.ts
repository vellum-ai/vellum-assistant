/**
 * Shared Chrome CDP session management.
 *
 * Consolidates the duplicated launch / readiness / window-management logic
 * that was previously copy-pasted across the Amazon and DoorDash CLIs.
 * Callers get back a {@link CdpSession} with structured metadata so they can
 * make cleanup decisions (e.g. only kill Chrome if *we* launched it).
 */

import { execSync, spawn as spawnChild } from "node:child_process";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_CDP_BASE = `http://localhost:${DEFAULT_CDP_PORT}`;
const DEFAULT_USER_DATA_DIR = pathJoin(
  homedir(),
  "Library/Application Support/Google/Chrome-CDP",
);
const CHROME_APP_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CdpSession {
  /** Base URL for the CDP HTTP endpoints (e.g. `http://localhost:9222`). */
  baseUrl: string;
  /** Whether this helper launched Chrome (true) or it was already running (false). */
  launchedByUs: boolean;
  /** The `--user-data-dir` used for the Chrome instance. */
  userDataDir: string;
}

export interface EnsureChromeOptions {
  /** CDP port. Defaults to `9222`. */
  port?: number;
  /** User data directory for Chrome. Defaults to `~/Library/Application Support/Google/Chrome-CDP`. */
  userDataDir?: string;
  /** Initial URL to open when launching Chrome. */
  startUrl?: string;
}

// ---------------------------------------------------------------------------
// Readiness check
// ---------------------------------------------------------------------------

/**
 * Returns `true` when a CDP endpoint is responding at the given base URL
 * and has at least one open page tab. A CDP endpoint with zero tabs is
 * stale and unusable - callers should treat it as not ready.
 */
export async function isCdpReady(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<boolean> {
  try {
    const res = await fetch(`${cdpBase}/json/version`);
    if (!res.ok) return false;

    // Verify there's at least one page tab - a CDP endpoint with no tabs
    // is a stale Chrome process that should be relaunched.
    const listRes = await fetch(`${cdpBase}/json/list`);
    if (!listRes.ok) return false;
    const targets = (await listRes.json()) as Array<{ type: string }>;
    return targets.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Launch / ensure
// ---------------------------------------------------------------------------

/**
 * Ensure a Chrome instance with CDP is available. If one is already listening
 * on the target port, returns immediately. Otherwise spawns a new detached
 * Chrome process and waits for the CDP endpoint to become ready.
 *
 * Returns a {@link CdpSession} with metadata about the running instance.
 */
export async function ensureChromeWithCdp(
  options: EnsureChromeOptions = {},
): Promise<CdpSession> {
  const port = options.port ?? DEFAULT_CDP_PORT;
  const baseUrl = `http://localhost:${port}`;
  const userDataDir = options.userDataDir ?? DEFAULT_USER_DATA_DIR;

  if (await isCdpReady(baseUrl)) {
    return { baseUrl, launchedByUs: false, userDataDir };
  }

  // If CDP is responding but has no tabs (stale), kill the process holding the port.
  try {
    const versionRes = await fetch(`${baseUrl}/json/version`);
    if (versionRes.ok) {
      // Stale Chrome - CDP up but no tabs. Kill it so we can relaunch.
      try {
        execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, {
          stdio: "ignore",
        });
      } catch {
        // Ignore - process may have already exited.
      }
      // Brief wait for port to clear.
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // CDP not responding at all - port is free, proceed to launch.
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--force-renderer-accessibility`,
    `--user-data-dir=${userDataDir}`,
  ];
  if (options.startUrl) {
    args.push(options.startUrl);
  }

  spawnChild(CHROME_APP_PATH, args, {
    detached: true,
    stdio: "ignore",
  }).unref();

  // Poll until CDP responds (up to 15 s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpReady(baseUrl)) {
      return { baseUrl, launchedByUs: true, userDataDir };
    }
  }

  throw new Error("Chrome started but CDP endpoint not responding after 15s");
}

// ---------------------------------------------------------------------------
// Window management helpers
// ---------------------------------------------------------------------------

/**
 * Look up the first page target and return its WebSocket debugger URL.
 */
async function findPageTarget(cdpBase: string): Promise<string | null> {
  const res = await fetch(`${cdpBase}/json/list`);
  const targets = (await res.json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((t) => t.type === "page");
  return page?.webSocketDebuggerUrl ?? null;
}

/**
 * Set the window state of the Chrome window owning the first page target.
 * Used by both minimize and restore.
 */
async function setWindowState(
  cdpBase: string,
  windowState: "minimized" | "normal",
): Promise<void> {
  const wsUrl = await findPageTarget(cdpBase);
  if (!wsUrl) return;

  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${windowState} timed out`));
    }, 5000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Browser.getWindowForTarget" }));
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id: number;
        result?: { windowId: number };
        error?: { message: string };
      };
      if (msg.id === 1 && msg.result) {
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Browser.setWindowBounds",
            params: {
              windowId: msg.result.windowId,
              bounds: { windowState },
            },
          }),
        );
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("Browser.getWindowForTarget failed"));
      } else if (msg.id === 2) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) {
          reject(
            new Error(`Browser.setWindowBounds failed: ${msg.error.message}`),
          );
        } else {
          resolve();
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Minimize the Chrome window associated with the CDP session.
 */
export async function minimizeChromeWindow(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<void> {
  await setWindowState(cdpBase, "minimized");
}

/**
 * Restore (un-minimize) the Chrome window associated with the CDP session.
 */
export async function restoreChromeWindow(
  cdpBase: string = DEFAULT_CDP_BASE,
): Promise<void> {
  await setWindowState(cdpBase, "normal");
}
