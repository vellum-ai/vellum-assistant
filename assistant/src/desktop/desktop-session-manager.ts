/**
 * On-demand pod desktop: one Xtigervnc X server with its built-in VNC server
 * on localhost, an openbox window manager, the vncconfig clipboard bridge and
 * Playwright's Chromium.
 *
 * The process tree starts lazily on the first `/v1/desktop/stream` socket,
 * serves one viewer at a time, lingers for a while after the last viewer
 * leaves so a reconnect is instant, and is torn down on expiry, on a crash of
 * the X server or window manager, or on runtime shutdown.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { importPlaywright } from "../tools/browser/runtime-check.js";
import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { terminateProcessTree } from "../util/host-process.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";
import { sleep } from "../util/retry.js";

const log = getLogger("desktop-session");

export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_VNC_PORT = 5999;
export const DESKTOP_GEOMETRY = "1440x900";
export const DESKTOP_LINGER_MS = 5 * 60_000;
const VNC_READY_DEADLINE_MS = 10_000;
const VNC_PROBE_INTERVAL_MS = 100;
const KILL_GRACE_MS = 2_000;
const CHROMIUM_INSTALL_TIMEOUT_MS = 300_000;

export interface DesktopInfo {
  readonly display: string;
  readonly vncPort: number;
}

export type DesktopChildRole =
  | "x-server"
  | "window-manager"
  | "clipboard"
  | "browser";

/** The slice of `Bun.Subprocess` the manager drives, so tests can fake it. */
export interface DesktopChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface DesktopSpawnRequest {
  readonly cmd: readonly string[];
  readonly env: Record<string, string>;
}

/** Callback surface of the socket holding the viewer slot. */
export interface DesktopViewer {
  /** The desktop went away underneath the viewer (crash, idle expiry, shutdown). */
  onDesktopLost(reason: string): void;
}

export type AcquireViewerSlotResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "busy" | "shutting-down" };

export interface DesktopSessionManagerOptions {
  readonly spawn?: (
    role: DesktopChildRole,
    request: DesktopSpawnRequest,
  ) => DesktopChild;
  /** Whether the VNC server accepts connections on `port`. */
  readonly probeVncPort?: (port: number) => Promise<boolean>;
  /** Path of the Chromium binary to launch, installing it when needed. */
  readonly resolveChromiumPath?: () => Promise<string>;
  readonly killProcessGroup?: (child: DesktopChild) => void;
  readonly lingerMs?: number;
  readonly readyDeadlineMs?: number;
  readonly profileDir?: string;
}

export class DesktopSessionManager {
  private readonly children = new Map<DesktopChildRole, DesktopChild>();
  private starting: Promise<DesktopInfo> | null = null;
  private running = false;
  /** Bumped on every teardown so an in-flight start notices it lost its tree. */
  private generation = 0;
  private viewer: DesktopViewer | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private ingressClosed = false;

  private readonly spawn: NonNullable<DesktopSessionManagerOptions["spawn"]>;
  private readonly probeVncPort: NonNullable<
    DesktopSessionManagerOptions["probeVncPort"]
  >;
  private readonly resolveChromiumPath: NonNullable<
    DesktopSessionManagerOptions["resolveChromiumPath"]
  >;
  private readonly killProcessGroup: NonNullable<
    DesktopSessionManagerOptions["killProcessGroup"]
  >;
  private readonly lingerMs: number;
  private readonly readyDeadlineMs: number;
  private readonly profileDir: string;

  constructor(options: DesktopSessionManagerOptions = {}) {
    this.spawn = options.spawn ?? spawnDetached;
    this.probeVncPort = options.probeVncPort ?? probeTcpPort;
    this.resolveChromiumPath =
      options.resolveChromiumPath ?? resolvePlaywrightChromium;
    this.killProcessGroup = options.killProcessGroup ?? killProcessGroup;
    this.lingerMs = options.lingerMs ?? DESKTOP_LINGER_MS;
    this.readyDeadlineMs = options.readyDeadlineMs ?? VNC_READY_DEADLINE_MS;
    this.profileDir =
      options.profileDir ?? join(getDataDir(), "desktop-profile");
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasViewer(): boolean {
    return this.viewer !== null;
  }

  // ── Viewer slot ────────────────────────────────────────────────────

  acquireViewerSlot(viewer: DesktopViewer): AcquireViewerSlotResult {
    if (this.ingressClosed) {
      return { ok: false, reason: "shutting-down" };
    }
    if (this.viewer) {
      return { ok: false, reason: "busy" };
    }
    this.viewer = viewer;
    this.clearLinger();
    return { ok: true };
  }

  /**
   * Give the slot back. Only the holder can release it, so a socket that was
   * turned away as busy never disturbs the viewer that turned it away.
   */
  releaseViewerSlot(viewer: DesktopViewer): void {
    if (this.viewer !== viewer) {
      return;
    }
    this.viewer = null;
    if (this.running || this.starting) {
      this.armLinger();
    }
  }

  // ── Process tree ───────────────────────────────────────────────────

  /** Start the desktop if needed. Concurrent callers share one start. */
  ensureDesktopRunning(): Promise<DesktopInfo> {
    if (this.ingressClosed) {
      return Promise.reject(new Error("Desktop ingress is closed"));
    }
    if (this.running) {
      void this.ensureBrowser(this.childEnv(), this.generation);
      return Promise.resolve(desktopInfo());
    }
    this.starting ??= this.startDesktop().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Refuse new viewers and kill the process tree. Safe to call repeatedly. */
  destroy(): void {
    this.ingressClosed = true;
    this.teardown("shutdown");
  }

  private async startDesktop(): Promise<DesktopInfo> {
    const generation = this.generation;
    const env = this.childEnv();
    this.launch("x-server", xServerCommand(), env);

    const ready = await this.waitForVnc(generation);
    if (this.generation !== generation) {
      throw new Error("Desktop was torn down while starting");
    }
    if (!ready) {
      this.teardown("vnc-not-ready");
      throw new Error(
        `Desktop VNC server not ready on port ${DESKTOP_VNC_PORT} after ${this.readyDeadlineMs}ms`,
      );
    }

    this.launch("window-manager", ["openbox"], env);
    this.launch("clipboard", ["vncconfig", "-nowin"], env);
    this.running = true;
    log.info({ display: DESKTOP_DISPLAY }, "Desktop started");
    void this.ensureBrowser(env, generation);
    return desktopInfo();
  }

  private async waitForVnc(generation: number): Promise<boolean> {
    const deadline = Date.now() + this.readyDeadlineMs;
    while (this.generation === generation) {
      if (await this.probeVncPort(DESKTOP_VNC_PORT)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(VNC_PROBE_INTERVAL_MS);
    }
    return false;
  }

  /**
   * Launch Chromium unless it is already up. Runs after the X server is
   * serving so the viewer sees a desktop while a first-time install
   * completes. A user closing the browser is normal, so its exit never tears
   * the desktop down; the next viewer gets a fresh window.
   */
  private async ensureBrowser(
    env: Record<string, string>,
    generation: number,
  ): Promise<void> {
    if (this.children.has("browser")) {
      return;
    }
    try {
      const executable = await this.resolveChromiumPath();
      if (this.generation !== generation || this.children.has("browser")) {
        return;
      }
      mkdirSync(this.profileDir, { recursive: true });
      this.launch("browser", browserCommand(executable, this.profileDir), env);
    } catch (err) {
      log.warn({ err }, "Desktop browser failed to launch");
    }
  }

  private launch(
    role: DesktopChildRole,
    cmd: readonly string[],
    env: Record<string, string>,
  ): void {
    const child = this.spawn(role, { cmd, env });
    this.children.set(role, child);
    child.exited.then(
      (code) => this.onChildExit(role, child, code),
      (err: unknown) => this.onChildExit(role, child, err),
    );
  }

  private onChildExit(
    role: DesktopChildRole,
    child: DesktopChild,
    outcome: unknown,
  ): void {
    if (this.children.get(role) !== child) {
      return;
    }
    this.children.delete(role);
    if (role === "browser") {
      log.info({ outcome }, "Desktop browser exited");
      return;
    }
    log.warn({ role, outcome }, "Desktop process exited, tearing down");
    this.teardown(`${role} exited`);
  }

  private teardown(reason: string): void {
    this.clearLinger();
    this.generation += 1;
    this.running = false;
    for (const child of this.children.values()) {
      this.killProcessGroup(child);
    }
    this.children.clear();
    const viewer = this.viewer;
    this.viewer = null;
    if (viewer) {
      viewer.onDesktopLost(reason);
    }
  }

  private armLinger(): void {
    this.clearLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      log.info("Desktop idle, tearing down");
      this.teardown("idle");
    }, this.lingerMs);
    this.lingerTimer.unref?.();
  }

  private clearLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  private childEnv(): Record<string, string> {
    return { ...buildSanitizedEnv(), DISPLAY: DESKTOP_DISPLAY };
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function xServerCommand(): string[] {
  return [
    "Xtigervnc",
    DESKTOP_DISPLAY,
    "-localhost",
    "-SecurityTypes",
    "None",
    "-rfbport",
    String(DESKTOP_VNC_PORT),
    "-geometry",
    DESKTOP_GEOMETRY,
    "-depth",
    "24",
    "-desktop",
    "Vellum",
  ];
}

function browserCommand(executable: string, profileDir: string): string[] {
  // The daemon runs as root in the pod, where Chromium refuses its own
  // sandbox; Playwright launches with the same flag.
  return [
    executable,
    "--no-sandbox",
    "--no-first-run",
    "--disable-dev-shm-usage",
    "--start-maximized",
    `--user-data-dir=${profileDir}`,
  ];
}

function desktopInfo(): DesktopInfo {
  return { display: DESKTOP_DISPLAY, vncPort: DESKTOP_VNC_PORT };
}

// ---------------------------------------------------------------------------
// Default collaborators
// ---------------------------------------------------------------------------

function spawnDetached(
  _role: DesktopChildRole,
  request: DesktopSpawnRequest,
): DesktopChild {
  // Each child leads its own process group so teardown can kill everything
  // it forked (Chromium's renderers, openbox's autostart) in one signal.
  return Bun.spawn([...request.cmd], {
    env: request.env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
}

/** SIGTERM the group so X and Chromium exit cleanly, then hard-kill stragglers. */
function killProcessGroup(child: DesktopChild): void {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone, or not a group leader; the tree kill below covers it.
  }
  setTimeout(() => terminateProcessTree(child), KILL_GRACE_MS).unref();
}

async function probeTcpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          resolve(true);
          socket.end();
        },
        data() {},
        connectError() {
          resolve(false);
        },
      },
    }).catch(() => resolve(false));
  });
}

async function resolvePlaywrightChromium(): Promise<string> {
  const { chromium } = await importPlaywright();
  const executable = chromium.executablePath();
  if (existsSync(executable)) {
    return executable;
  }
  log.info("Desktop browser not installed, installing via playwright");
  const install = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const timer = setTimeout(() => install.kill(), CHROMIUM_INSTALL_TIMEOUT_MS);
  const exitCode = await install.exited.finally(() => clearTimeout(timer));
  if (exitCode !== 0) {
    const stderr = (await new Response(install.stderr).text()).trim();
    throw new Error(
      `playwright install chromium failed: ${stderr || `exit code ${exitCode}`}`,
    );
  }
  return executable;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let sharedManager: DesktopSessionManager | null = null;

/**
 * The process-wide desktop session manager. One instance because there is
 * one display and one VNC port; lazily created so importing this module
 * costs nothing until a socket arrives.
 */
export function getDesktopSessionManager(): DesktopSessionManager {
  sharedManager ??= new DesktopSessionManager();
  return sharedManager;
}
