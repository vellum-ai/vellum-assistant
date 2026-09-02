import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../config/schema.js";
import { isPodDesktopEnabled } from "./desktop-feature.js";
import {
  DESKTOP_DISPLAY,
  DESKTOP_VNC_PORT,
  type DesktopChild,
  type DesktopChildRole,
  DesktopSessionManager,
  type DesktopSpawnRequest,
} from "./desktop-session-manager.js";
import {
  DesktopStreamBridge,
  type DesktopTcpHandlers,
  type DesktopTcpSocket,
} from "./desktop-stream-bridge.js";

const profileDir = mkdtempSync(join(tmpdir(), "desktop-session-test-"));
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

/** A child the test exits by hand. */
class FakeChild implements DesktopChild {
  private static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  readonly exited: Promise<number>;
  private settle!: (code: number) => void;

  constructor(
    readonly role: DesktopChildRole,
    readonly request: DesktopSpawnRequest,
  ) {
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  kill(): void {}

  exit(code = 0): void {
    this.settle(code);
  }
}

const LINGER_MS = 20;

function newManager() {
  const spawned: FakeChild[] = [];
  const killed: FakeChild[] = [];
  let vncReady = true;
  const manager = new DesktopSessionManager({
    spawn: (role, request) => {
      const child = new FakeChild(role, request);
      spawned.push(child);
      return child;
    },
    probeVncPort: async () => vncReady,
    resolveChromiumPath: async () => "/fake/chromium",
    killProcessGroup: (child) => {
      killed.push(child as FakeChild);
    },
    lingerMs: LINGER_MS,
    readyDeadlineMs: 30,
    profileDir,
  });
  return {
    manager,
    spawned,
    killed,
    setVncReady: (ready: boolean) => {
      vncReady = ready;
    },
    child: (role: DesktopChildRole) =>
      spawned.filter((c) => c.role === role).at(-1)!,
    roles: () => spawned.map((c) => c.role),
  };
}

/** Let the browser launch (one awaited path resolution) land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newViewer() {
  const lost: string[] = [];
  return {
    lost,
    viewer: { onDesktopLost: (reason: string) => lost.push(reason) },
  };
}

describe("DesktopSessionManager process tree", () => {
  test("concurrent callers share one start of the whole tree", async () => {
    const h = newManager();
    const [a, b] = await Promise.all([
      h.manager.ensureDesktopRunning(),
      h.manager.ensureDesktopRunning(),
    ]);
    await settle();

    expect(a).toEqual({ display: DESKTOP_DISPLAY, vncPort: DESKTOP_VNC_PORT });
    expect(b).toEqual(a);
    expect(h.roles()).toEqual([
      "x-server",
      "window-manager",
      "clipboard",
      "browser",
    ]);
    expect(h.manager.isRunning).toBe(true);

    const x = h.child("x-server").request.cmd;
    expect(x.slice(0, 2)).toEqual(["Xtigervnc", ":99"]);
    expect(x).toContain("-localhost");
    expect(x[x.indexOf("-SecurityTypes") + 1]).toBe("None");
    expect(x[x.indexOf("-rfbport") + 1]).toBe(String(DESKTOP_VNC_PORT));
    for (const role of ["window-manager", "clipboard", "browser"] as const) {
      expect(h.child(role).request.env.DISPLAY).toBe(":99");
    }
    expect(h.child("clipboard").request.cmd).toEqual(["vncconfig", "-nowin"]);
    const browser = h.child("browser").request.cmd;
    expect(browser[0]).toBe("/fake/chromium");
    expect(browser).toContain(`--user-data-dir=${profileDir}`);
  });

  test("a VNC port that never opens fails the start and kills the X server, and a retry works", async () => {
    const h = newManager();
    h.setVncReady(false);

    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(/not ready/);
    expect(h.killed).toEqual([h.child("x-server")]);
    expect(h.manager.isRunning).toBe(false);

    h.setVncReady(true);
    await h.manager.ensureDesktopRunning();
    expect(h.manager.isRunning).toBe(true);
    expect(h.roles().filter((r) => r === "x-server")).toHaveLength(2);
  });

  test("an X server exit tears the tree down and tells the viewer", async () => {
    const h = newManager();
    const { viewer, lost } = newViewer();
    expect(h.manager.acquireViewerSlot(viewer)).toEqual({ ok: true });
    await h.manager.ensureDesktopRunning();
    await settle();

    h.child("x-server").exit(1);
    await settle();

    expect(lost).toEqual(["x-server exited"]);
    expect(h.manager.isRunning).toBe(false);
    expect(h.manager.hasViewer).toBe(false);
    expect(h.killed.map((c) => c.role).sort()).toEqual([
      "browser",
      "clipboard",
      "window-manager",
    ]);
  });

  test("a browser exit keeps the desktop and the next viewer gets a fresh one", async () => {
    const h = newManager();
    await h.manager.ensureDesktopRunning();
    await settle();

    h.child("browser").exit(0);
    await settle();
    expect(h.manager.isRunning).toBe(true);
    expect(h.killed).toEqual([]);

    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.roles().filter((r) => r === "browser")).toHaveLength(2);
  });

  test("destroy kills everything, is idempotent, and refuses what comes after", async () => {
    const h = newManager();
    await h.manager.ensureDesktopRunning();
    await settle();

    h.manager.destroy();
    h.manager.destroy();

    expect(h.killed).toHaveLength(4);
    expect(h.manager.isRunning).toBe(false);
    expect(h.manager.acquireViewerSlot(newViewer().viewer)).toEqual({
      ok: false,
      reason: "shutting-down",
    });
    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow();
  });
});

describe("DesktopSessionManager viewer slot", () => {
  test("holds one viewer and only the holder can release it", () => {
    const h = newManager();
    const first = newViewer().viewer;
    const second = newViewer().viewer;

    expect(h.manager.acquireViewerSlot(first)).toEqual({ ok: true });
    expect(h.manager.acquireViewerSlot(second)).toEqual({
      ok: false,
      reason: "busy",
    });

    h.manager.releaseViewerSlot(second);
    expect(h.manager.hasViewer).toBe(true);

    h.manager.releaseViewerSlot(first);
    expect(h.manager.hasViewer).toBe(false);
    expect(h.manager.acquireViewerSlot(second)).toEqual({ ok: true });
  });

  test("the tree lingers after the last viewer leaves, then is torn down", async () => {
    const h = newManager();
    const { viewer } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    h.manager.releaseViewerSlot(viewer);
    expect(h.manager.isRunning).toBe(true);

    await sleep(LINGER_MS * 2);
    expect(h.manager.isRunning).toBe(false);
    expect(h.killed).toHaveLength(4);
  });

  test("a viewer returning inside the linger window keeps the tree", async () => {
    const h = newManager();
    const { viewer } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    h.manager.releaseViewerSlot(viewer);
    h.manager.acquireViewerSlot(viewer);
    await sleep(LINGER_MS * 2);

    expect(h.manager.isRunning).toBe(true);
    expect(h.killed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class FakeWs {
  readonly sent: Uint8Array[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
  }
}

class FakeTcp implements DesktopTcpSocket {
  readonly writes: Uint8Array[] = [];
  ended = false;
  handlers!: DesktopTcpHandlers;

  write(data: Uint8Array): number {
    this.writes.push(data);
    return data.byteLength;
  }

  end(): void {
    this.ended = true;
  }
}

function newBridge(manager: DesktopSessionManager, enabled = true) {
  const ws = new FakeWs();
  const tcp = new FakeTcp();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = new DesktopStreamBridge(ws, {
    enabled,
    manager,
    connect: async (_port, handlers) => {
      tcp.handlers = handlers;
      await gate;
      return tcp;
    },
  });
  return { ws, tcp, bridge, connectNow: () => release!() };
}

describe("DesktopStreamBridge", () => {
  test("pumps bytes both ways and flushes frames that beat the VNC socket", async () => {
    const h = newManager();
    const b = newBridge(h.manager);
    const started = b.bridge.start();
    await settle();

    b.bridge.handleClientFrame(new Uint8Array([1, 2, 3]));
    b.bridge.handleClientFrame(new Uint8Array([4]).buffer);
    b.bridge.handleClientFrame("text frames are not RFB");
    expect(b.tcp.writes).toEqual([]);

    b.connectNow();
    await started;
    expect(b.tcp.writes).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
    ]);

    b.tcp.handlers.onData(new Uint8Array([9, 9]));
    expect(b.ws.sent).toEqual([new Uint8Array([9, 9])]);
    expect(b.ws.closeCode).toBeNull();

    b.bridge.handleClose();
    expect(b.tcp.ended).toBe(true);
    expect(h.manager.hasViewer).toBe(false);
  });

  test("a second socket closes 1013 and leaves the first untouched", async () => {
    const h = newManager();
    const first = newBridge(h.manager);
    first.connectNow();
    await first.bridge.start();

    const second = newBridge(h.manager);
    await second.bridge.start();

    expect(second.ws.closeCode).toBe(1013);
    expect(first.ws.closeCode).toBeNull();
    expect(h.manager.hasViewer).toBe(true);

    second.bridge.handleClose();
    expect(h.manager.hasViewer).toBe(true);
  });

  test("closes 1011 when the desktop fails to start and frees the slot", async () => {
    const h = newManager();
    h.setVncReady(false);
    const b = newBridge(h.manager);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(1011);
    expect(h.manager.hasViewer).toBe(false);
  });

  test("closes 1011 when the desktop dies under the viewer", async () => {
    const h = newManager();
    const b = newBridge(h.manager);
    b.connectNow();
    await b.bridge.start();
    await settle();

    h.child("window-manager").exit(1);
    await settle();

    expect(b.ws.closeCode).toBe(1011);
    expect(b.ws.closeReason).toContain("window-manager exited");
    expect(b.tcp.ended).toBe(true);
  });

  test("closes 1008 when the desktop is disabled, without touching the manager", async () => {
    const h = newManager();
    const b = newBridge(h.manager, false);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(1008);
    expect(h.spawned).toEqual([]);
    expect(h.manager.hasViewer).toBe(false);
  });

  test("closes 1001 once the runtime is shutting down", async () => {
    const h = newManager();
    h.manager.destroy();
    const b = newBridge(h.manager);
    await b.bridge.start();

    expect(b.ws.closeCode).toBe(1001);
  });
});

describe("isPodDesktopEnabled", () => {
  const config = {} as AssistantConfig;

  test("needs both the flag and a containerized runtime", () => {
    setOverridesForTesting({ "pod-desktop": true });
    expect(isPodDesktopEnabled(config, { IS_CONTAINERIZED: "true" })).toBe(
      true,
    );
    expect(isPodDesktopEnabled(config, {})).toBe(false);

    setOverridesForTesting({ "pod-desktop": false });
    expect(isPodDesktopEnabled(config, { IS_CONTAINERIZED: "true" })).toBe(
      false,
    );
  });
});
