/**
 * On-demand assistant desktop: Xtigervnc (VNC on loopback only, so the
 * authenticated `/v1/desktop/stream` upgrade is the sole way in), openbox, the
 * xcompmgr compositor, the tint2 dock, the tigervncconfig clipboard bridge and
 * Playwright's Chromium, started by the first viewer and lingering after the
 * last one leaves so a reconnect is instant.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ensureChromium,
  importPlaywright,
} from "../tools/browser/runtime-check.js";
import { terminateProcessTree } from "../util/host-process.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";
import { sleep } from "../util/retry.js";
import { writeDesktopPanelConfig } from "./desktop-panel-config.js";

const log = getLogger("desktop-session");

const DESKTOP_DISPLAY = ":99";
export const DESKTOP_VNC_PORT = 5999;
const DESKTOP_WIDTH = 1440;
const DESKTOP_HEIGHT = 900;
const DESKTOP_GEOMETRY = `${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}`;
const DESKTOP_LINGER_MS = 5 * 60_000;
const VNC_READY_DEADLINE_MS = 10_000;
const VNC_PROBE_INTERVAL_MS = 100;
const KILL_GRACE_MS = 2_000;
const BROWSER_CRASH_WINDOW_MS = 60_000;
const BROWSER_CRASH_LIMIT = 3;

/**
 * What the desktop children see. Deliberately not `buildSanitizedEnv()`: its
 * kata chroot PATH and LD_LIBRARY_PATH overlay would give this Chromium
 * different libraries than the browser tool's, which launches with the plain
 * process env.
 */
const DESKTOP_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

/**
 * Close codes for `/v1/desktop/stream`. Application-range values cannot
 * collide with velay's own 1013 or be remapped by the gateway's velay bridge.
 */
export const DESKTOP_CLOSE = {
  goingAway: 1001,
  unavailable: 4008,
  failed: 4011,
  busy: 4013,
} as const;

export type DesktopCloseCode =
  (typeof DESKTOP_CLOSE)[keyof typeof DESKTOP_CLOSE];

const SHUTTING_DOWN_LOSS: DesktopLoss = {
  code: DESKTOP_CLOSE.goingAway,
  reason: "The assistant is shutting down",
};
export const START_FAILED_LOSS: DesktopLoss = {
  code: DESKTOP_CLOSE.failed,
  reason: "Desktop failed to start",
};
const BUSY_LOSS: DesktopLoss = {
  code: DESKTOP_CLOSE.busy,
  reason: "Desktop is in use by another viewer",
};

export type DesktopChildRole =
  | "x-server"
  | "window-manager"
  | "compositor"
  | "panel"
  | "clipboard"
  | "browser";

/** Children whose death costs the dock's looks, not the desktop. */
const COSMETIC_ROLES: ReadonlySet<DesktopChildRole> = new Set([
  "compositor",
  "panel",
]);

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

/** Why a viewer cannot have the desktop, as the close code it relays. */
export interface DesktopLoss {
  readonly code: DesktopCloseCode;
  readonly reason: string;
}

/** Callback surface of the socket holding the viewer slot. */
export interface DesktopViewer {
  onDesktopLost(loss: DesktopLoss): void;
}

/** A start that failed, carrying the loss for a viewer `onDesktopLost` missed. */
export class DesktopStartError extends Error {
  constructor(
    readonly loss: DesktopLoss,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DesktopStartError";
  }
}

export interface DesktopTcpSocket {
  /** Returns the bytes accepted; fewer than offered means backpressure. */
  write(data: Uint8Array): number;
  end(): void;
}

export interface DesktopTcpHandlers {
  onData(data: Uint8Array): void;
  onDrain(): void;
  onClose(): void;
  onError(err: Error): void;
}

type DesktopSignal = "SIGTERM" | "SIGKILL";

type ViewerSlotResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly loss: DesktopLoss };

interface DesktopSessionManagerOptions {
  readonly spawn?: (
    role: DesktopChildRole,
    request: DesktopSpawnRequest,
  ) => DesktopChild;
  /** PATH lookup for the desktop binaries; `null` when one is missing. */
  readonly which?: (binary: string) => string | null;
  /** Whether the VNC server accepts connections on `port`. */
  readonly probeVncPort?: (port: number) => Promise<boolean>;
  /** Path of the Chromium binary to launch, installing it when needed. */
  readonly resolveChromiumPath?: () => Promise<string>;
  readonly killProcessGroup?: (
    child: DesktopChild,
    signal: DesktopSignal,
  ) => void;
  readonly lingerMs?: number;
  readonly readyDeadlineMs?: number;
  readonly killGraceMs?: number;
  readonly profileDir?: string;
  /** Where the generated tint2rc, its launchers and their icons are written. */
  readonly panelConfigDir?: string;
  /** Where the children's allowlisted env is read from. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

/** The desktop's binaries, resolved once per start. */
interface DesktopBinaries {
  readonly xServer: string;
  readonly windowManager: string;
  readonly compositor: string;
  readonly panel: string;
  readonly clipboard: string;
  readonly terminal: string;
}

export class DesktopSessionManager {
  private readonly children = new Map<DesktopChildRole, DesktopChild>();
  private starting: Promise<void> | null = null;
  /** The kill of the last tree, which a new start waits out. */
  private tearingDown: Promise<void> | null = null;
  private running = false;
  /** Bumped on every teardown so an in-flight start notices it lost its tree. */
  private generation = 0;
  private viewer: DesktopViewer | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private ingressClosed = false;
  private browserExitsAt: number[] = [];
  /** Resolved for the current tree, and read again when the dock comes up. */
  private binaries: DesktopBinaries | null = null;
  /** Whether this tree has already had its one dock start attempted. */
  private panelStarted = false;

  private readonly spawn: NonNullable<DesktopSessionManagerOptions["spawn"]>;
  private readonly which: NonNullable<DesktopSessionManagerOptions["which"]>;
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
  private readonly killGraceMs: number;
  private readonly profileDir: string;
  private readonly panelConfigDir: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;

  constructor(options: DesktopSessionManagerOptions = {}) {
    this.spawn = options.spawn ?? spawnDetached;
    this.which = options.which ?? Bun.which;
    this.probeVncPort = options.probeVncPort ?? probeLoopbackPort;
    this.resolveChromiumPath =
      options.resolveChromiumPath ?? resolvePlaywrightChromium;
    this.killProcessGroup = options.killProcessGroup ?? killProcessGroup;
    this.lingerMs = options.lingerMs ?? DESKTOP_LINGER_MS;
    this.readyDeadlineMs = options.readyDeadlineMs ?? VNC_READY_DEADLINE_MS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.profileDir =
      options.profileDir ?? join(getDataDir(), "desktop-profile");
    this.panelConfigDir =
      options.panelConfigDir ?? join(getDataDir(), "desktop-panel");
    this.sourceEnv = options.sourceEnv ?? process.env;
  }

  // ── Viewer slot ────────────────────────────────────────────────────

  acquireViewerSlot(viewer: DesktopViewer): ViewerSlotResult {
    if (this.ingressClosed) {
      return { ok: false, loss: SHUTTING_DOWN_LOSS };
    }
    if (this.viewer) {
      return { ok: false, loss: BUSY_LOSS };
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

  /**
   * Start the desktop if needed. Concurrent callers share one start; it
   * rejects with a `DesktopStartError`.
   */
  ensureDesktopRunning(): Promise<void> {
    if (this.ingressClosed) {
      return Promise.reject(ingressClosedError());
    }
    if (this.running) {
      void this.ensureBrowser(this.childEnv(), this.generation);
      return Promise.resolve();
    }
    this.starting ??= this.startDesktop().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Refuse new viewers and kill the process tree. Resolves once every child
   * has exited or been hard-killed after the grace period. Safe to repeat.
   */
  destroy(): Promise<void> {
    this.ingressClosed = true;
    return this.teardown(SHUTTING_DOWN_LOSS);
  }

  private async startDesktop(): Promise<void> {
    // The last tree may still be in its kill grace; its X server holds the
    // display and port until it is gone.
    await this.tearingDown;
    if (this.ingressClosed) {
      throw ingressClosedError();
    }
    const generation = this.generation;
    let env: Record<string, string>;
    try {
      this.binaries = this.resolveBinaries();
      env = this.childEnv();
      this.launch("x-server", xServerCommand(this.binaries.xServer), env);
      const ready = await this.waitForVnc(generation);
      if (this.generation !== generation) {
        throw new Error("Desktop was torn down while starting");
      }
      if (!ready) {
        throw new Error(
          `Desktop VNC server not ready on port ${DESKTOP_VNC_PORT} after ${this.readyDeadlineMs}ms`,
        );
      }
      this.launch("window-manager", [this.binaries.windowManager], env);
      // Before the dock, which only gets the ARGB visual its rounded corners
      // and translucency need if a compositor is already running.
      this.launchCosmetic("compositor", [this.binaries.compositor], env);
      this.launch("clipboard", [this.binaries.clipboard, "-nowin"], env);
    } catch (err) {
      if (this.generation === generation) {
        void this.teardown(START_FAILED_LOSS);
      }
      throw new DesktopStartError(START_FAILED_LOSS, err);
    }
    this.running = true;
    log.info({ display: DESKTOP_DISPLAY }, "Desktop started");
    void this.ensureBrowser(env, generation);
  }

  /** Preflight every binary the tree needs before anything is spawned. */
  private resolveBinaries(): DesktopBinaries {
    const xServer = this.which("Xtigervnc");
    const windowManager = this.which("openbox");
    const compositor = this.which("xcompmgr");
    const panel = this.which("tint2");
    const clipboard = this.which("tigervncconfig") ?? this.which("vncconfig");
    const terminal = this.which("xterm");
    if (
      !xServer ||
      !windowManager ||
      !compositor ||
      !panel ||
      !clipboard ||
      !terminal
    ) {
      const missing = [
        xServer ? null : "Xtigervnc",
        windowManager ? null : "openbox",
        compositor ? null : "xcompmgr",
        panel ? null : "tint2",
        clipboard ? null : "tigervncconfig",
        terminal ? null : "xterm",
      ].filter(Boolean);
      throw new Error(
        `Desktop binaries missing from PATH: ${missing.join(", ")}`,
      );
    }
    return {
      xServer,
      windowManager,
      compositor,
      panel,
      clipboard,
      terminal,
    };
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
   * Launch Chromium unless it is already up, and the dock along with the first
   * one. Runs after the X server is serving so the viewer sees a desktop while
   * a first-time install completes; an install failure takes the desktop down
   * so the viewer is not left staring at an empty one.
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
      this.startPanel(executable, env);
      this.launch("browser", browserCommand(executable, this.profileDir), env);
    } catch (err) {
      log.warn({ err }, "Desktop browser failed to launch");
      if (this.generation === generation) {
        void this.teardown({
          code: DESKTOP_CLOSE.failed,
          reason: "Desktop browser failed to start",
        });
      }
    }
  }

  /**
   * Bring the dock up once per tree. It waits on Chromium because its launcher
   * points at that executable, and its window manager and compositor are long
   * up by then.
   */
  private startPanel(chromiumPath: string, env: Record<string, string>): void {
    const binaries = this.binaries;
    if (this.panelStarted || !binaries) {
      return;
    }
    this.panelStarted = true;
    let configPath: string;
    try {
      configPath = writeDesktopPanelConfig({
        configDir: this.panelConfigDir,
        chromiumPath,
        chromiumProfileDir: this.profileDir,
        terminalPath: binaries.terminal,
      });
    } catch (err) {
      log.warn({ err }, "Desktop dock config could not be written");
      return;
    }
    this.launchCosmetic("panel", [binaries.panel, "-c", configPath], env);
  }

  /** Spawn a child the desktop looks worse without but works fine without. */
  private launchCosmetic(
    role: DesktopChildRole,
    cmd: readonly string[],
    env: Record<string, string>,
  ): void {
    try {
      this.launch(role, cmd, env);
    } catch (err) {
      log.warn({ err, role }, "Desktop child failed to start");
    }
  }

  private launch(
    role: DesktopChildRole,
    cmd: readonly string[],
    env: Record<string, string>,
  ): void {
    const stale = this.children.get(role);
    if (stale) {
      log.warn({ role, pid: stale.pid }, "Desktop process already running");
      void this.killAll(new Map([[role, stale]]));
    }
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
      this.onBrowserExit();
      return;
    }
    if (COSMETIC_ROLES.has(role)) {
      // A dead dock or compositor costs the desktop its looks, not its use.
      log.warn({ role, outcome }, "Desktop child exited");
      return;
    }
    log.warn({ role, outcome }, "Desktop process exited, tearing down");
    void this.teardown({
      code: DESKTOP_CLOSE.failed,
      reason: `Desktop stopped: ${role} exited`,
    });
  }

  /**
   * A closed browser is normal use when nobody is watching; the next viewer
   * gets a fresh window. Under a viewer it is relaunched so they are not
   * stranded on an empty desktop, unless it keeps dying.
   */
  private onBrowserExit(): void {
    if (!this.viewer || !this.running) {
      return;
    }
    const now = Date.now();
    this.browserExitsAt = this.browserExitsAt.filter(
      (at) => now - at < BROWSER_CRASH_WINDOW_MS,
    );
    this.browserExitsAt.push(now);
    if (this.browserExitsAt.length > BROWSER_CRASH_LIMIT) {
      log.warn("Desktop browser is crash looping, tearing down");
      void this.teardown({
        code: DESKTOP_CLOSE.failed,
        reason: "Desktop browser keeps crashing",
      });
      return;
    }
    void this.ensureBrowser(this.childEnv(), this.generation);
  }

  /**
   * Kill the tree. The viewer, if any, hears `loss` before the kill starts;
   * the linger path passes none since nobody is watching by then.
   */
  private teardown(loss?: DesktopLoss): Promise<void> {
    this.clearLinger();
    this.generation += 1;
    this.running = false;
    this.browserExitsAt = [];
    this.binaries = null;
    this.panelStarted = false;
    const children = new Map(this.children);
    this.children.clear();
    const viewer = this.viewer;
    this.viewer = null;
    if (viewer && loss) {
      viewer.onDesktopLost(loss);
    }
    // Chain onto an earlier kill still in its grace so a start waits for both.
    const done: Promise<void> = Promise.all([
      this.tearingDown,
      this.killAll(children),
    ])
      .then(() => undefined)
      .finally(() => {
        if (this.tearingDown === done) {
          this.tearingDown = null;
        }
      });
    this.tearingDown = done;
    return done;
  }

  /**
   * SIGTERM so X and Chromium exit cleanly, then SIGKILL whatever is left and
   * wait for it too: a killed X server holds the display and port until it is
   * reaped. Both waits are bounded by the grace so shutdown cannot hang.
   */
  private async killAll(
    children: ReadonlyMap<DesktopChildRole, DesktopChild>,
  ): Promise<void> {
    if (children.size === 0) {
      return;
    }
    const alive = new Map(children);
    const exits = Promise.all(
      [...children].map(([role, child]) => {
        this.killProcessGroup(child, "SIGTERM");
        return child.exited.catch(() => 0).then(() => alive.delete(role));
      }),
    );
    await this.waitForExits(exits);
    if (alive.size === 0) {
      return;
    }
    for (const child of alive.values()) {
      this.killProcessGroup(child, "SIGKILL");
    }
    await this.waitForExits(exits);
    if (alive.size > 0) {
      const survivors = [...alive].map(([role, child]) => ({
        role,
        pid: child.pid,
      }));
      log.warn({ survivors }, "Desktop processes still alive after SIGKILL");
    }
  }

  private waitForExits(exits: Promise<unknown>): Promise<void> {
    let grace: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      exits.then(() => undefined),
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, this.killGraceMs);
      }),
    ]).finally(() => clearTimeout(grace));
  }

  private armLinger(): void {
    this.clearLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      log.info("Desktop idle, tearing down");
      void this.teardown();
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
    const env: Record<string, string> = {};
    for (const key of DESKTOP_ENV_KEYS) {
      const value = this.sourceEnv[key];
      if (value != null) {
        env[key] = value;
      }
    }
    env.DISPLAY = DESKTOP_DISPLAY;
    return env;
  }
}

function ingressClosedError(): DesktopStartError {
  return new DesktopStartError(
    SHUTTING_DOWN_LOSS,
    new Error("Desktop ingress is closed"),
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function xServerCommand(executable: string): string[] {
  return [
    executable,
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
  // sandbox; Playwright launches with the same flag. The explicit geometry
  // covers a window mapped before openbox is up to maximize it.
  return [
    executable,
    "--no-sandbox",
    "--no-first-run",
    "--disable-dev-shm-usage",
    "--start-maximized",
    "--window-position=0,0",
    `--window-size=${DESKTOP_WIDTH},${DESKTOP_HEIGHT}`,
    `--user-data-dir=${profileDir}`,
  ];
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

function killProcessGroup(child: DesktopChild, signal: DesktopSignal): void {
  if (signal === "SIGKILL") {
    terminateProcessTree(child);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Not a group leader, or already gone.
    child.kill(signal);
  }
}

/** Dial a loopback TCP port; resolves on connect, rejects when refused. */
export function connectLoopback(
  port: number,
  handlers: DesktopTcpHandlers,
): Promise<DesktopTcpSocket> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => resolve(socket),
        data: (_socket, data) => handlers.onData(data),
        drain: () => handlers.onDrain(),
        close: () => handlers.onClose(),
        error: (_socket, err) => handlers.onError(err),
        connectError: (_socket, err) => reject(err),
      },
    }).catch(reject);
  });
}

const silentHandlers: DesktopTcpHandlers = {
  onData() {},
  onDrain() {},
  onClose() {},
  onError() {},
};

async function probeLoopbackPort(port: number): Promise<boolean> {
  try {
    const socket = await connectLoopback(port, silentHandlers);
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function resolvePlaywrightChromium(): Promise<string> {
  const pw = await importPlaywright();
  await ensureChromium(pw);
  return pw.chromium.executablePath();
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let sharedManager: DesktopSessionManager | null = null;

/** One instance because there is one display and one VNC port. */
export function getDesktopSessionManager(): DesktopSessionManager {
  sharedManager ??= new DesktopSessionManager();
  return sharedManager;
}

/**
 * Shut the shared desktop down. Latches even when none was ever served, so a
 * socket arriving mid-shutdown cannot start a tree that nothing would kill.
 */
export function destroyDesktopSessionManager(): Promise<void> {
  return getDesktopSessionManager().destroy();
}
