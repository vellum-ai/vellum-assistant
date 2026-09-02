import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { waitFor } from "../__tests__/helpers/wait-for.js";
import { sleep } from "../util/retry.js";
import {
  type FakeDesktopOptions,
  KILL_GRACE_MS,
  LINGER_MS,
  newFakeDesktop,
  newViewer,
  settle,
} from "./__tests__/fake-desktop.js";
import {
  DESKTOP_VNC_PORT,
  type DesktopChildRole,
} from "./desktop-session-manager.js";

const BUSY = {
  ok: false,
  loss: { code: 4013, reason: "Desktop is in use by another viewer" },
} as const;
const SHUTTING_DOWN = {
  ok: false,
  loss: { code: 1001, reason: "The assistant is shutting down" },
} as const;

const profileDir = mkdtempSync(join(tmpdir(), "desktop-session-test-"));
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

function newManager(options: Omit<FakeDesktopOptions, "profileDir"> = {}) {
  return newFakeDesktop({ profileDir, ...options });
}

describe("DesktopSessionManager process tree", () => {
  test("concurrent callers share one start of the whole tree", async () => {
    const h = newManager({
      sourceEnv: {
        PATH: "/usr/bin",
        HOME: "/data",
        LANG: "C.UTF-8",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
        // Neither the kata chroot overlay nor secrets reach the desktop.
        LD_LIBRARY_PATH: "/data/system/usr/lib",
        VELLUM_SANDBOX_RUNTIME: "kata",
        OPENAI_API_KEY: "sk-secret",
      },
    });
    await Promise.all([
      h.manager.ensureDesktopRunning(),
      h.manager.ensureDesktopRunning(),
    ]);
    await settle();

    expect(h.roles()).toEqual([
      "x-server",
      "window-manager",
      "clipboard",
      "browser",
    ]);

    const x = h.child("x-server").request.cmd;
    expect(x.slice(0, 2)).toEqual(["/usr/bin/Xtigervnc", ":99"]);
    expect(x).toContain("-localhost");
    expect(x[x.indexOf("-SecurityTypes") + 1]).toBe("None");
    expect(x[x.indexOf("-rfbport") + 1]).toBe(String(DESKTOP_VNC_PORT));
    expect(x[x.indexOf("-geometry") + 1]).toBe("1440x900");
    for (const role of ["window-manager", "clipboard", "browser"] as const) {
      expect(h.child(role).request.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/data",
        LANG: "C.UTF-8",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
        DISPLAY: ":99",
      });
    }
    expect(h.child("window-manager").request.cmd).toEqual(["/usr/bin/openbox"]);
    expect(h.child("clipboard").request.cmd).toEqual([
      "/usr/bin/tigervncconfig",
      "-nowin",
    ]);
    const browser = h.child("browser").request.cmd;
    expect(browser[0]).toBe("/fake/chromium");
    expect(browser).toContain(`--user-data-dir=${profileDir}`);
    // Explicit geometry matching the X server, so the window does not depend
    // on openbox being up to honor --start-maximized.
    expect(browser).toContain("--window-position=0,0");
    expect(browser).toContain("--window-size=1440,900");

    // A running tree is reused rather than started again.
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(1);
  });

  test("falls back to vncconfig when tigervncconfig is absent", async () => {
    const h = newManager({ missingBinaries: ["tigervncconfig"] });
    await h.manager.ensureDesktopRunning();
    expect(h.child("clipboard").request.cmd).toEqual([
      "/usr/bin/vncconfig",
      "-nowin",
    ]);
  });

  test("a missing binary fails the start before anything is spawned", async () => {
    const h = newManager({
      missingBinaries: ["Xtigervnc", "tigervncconfig", "vncconfig"],
    });
    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(
      "Desktop binaries missing from PATH: Xtigervnc, tigervncconfig",
    );
    expect(h.spawned).toEqual([]);
  });

  test("a VNC port that never opens fails the start and kills the X server, and a retry works", async () => {
    const h = newManager();
    h.setVncReady(false);

    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(/not ready/);
    expect(h.terminated()).toEqual([h.child("x-server")]);

    h.setVncReady(true);
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(2);
  });

  test("a retry spawns its X server only after the failed one is gone", async () => {
    const h = newManager();
    h.setVncReady(false);
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);

    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(/not ready/);
    // The viewer hears about it before the kill grace, not after.
    expect(lost).toEqual([{ code: 4011, reason: "Desktop failed to start" }]);
    const first = h.child("x-server");
    expect(h.killed).toEqual([{ child: first, signal: "SIGTERM" }]);

    // Reconnect while the first X server is still ignoring its SIGTERM.
    h.setVncReady(true);
    const retry = h.manager.ensureDesktopRunning();
    await sleep(KILL_GRACE_MS / 2);
    expect(h.count("x-server")).toBe(1);

    // The SIGKILL alone does not free the display and port; the exit does.
    await waitFor(() => h.killed.length === 2, { intervalMs: 1 });
    expect(h.killed[1]).toEqual({ child: first, signal: "SIGKILL" });
    expect(h.count("x-server")).toBe(1);

    first.exit(0);
    await retry;
    expect(h.count("x-server")).toBe(2);
  });

  test("a retry stops waiting on an X server that survives SIGKILL", async () => {
    const h = newManager();
    h.setVncReady(false);
    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(/not ready/);

    h.setVncReady(true);
    const started = Date.now();
    await h.manager.ensureDesktopRunning();
    expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MS * 2 - 4);
    expect(h.killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.count("x-server")).toBe(2);
  });

  test("a spawn that fails after the X server is up rolls the tree back, and a retry starts clean", async () => {
    const failSpawn: DesktopChildRole[] = ["clipboard"];
    const h = newManager({ failSpawn });
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);

    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(
      "spawn clipboard failed",
    );
    expect(
      h
        .terminated()
        .map((c) => c.role)
        .sort(),
    ).toEqual(["window-manager", "x-server"]);
    expect(lost).toEqual([{ code: 4011, reason: "Desktop failed to start" }]);

    failSpawn.length = 0;
    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.roles().slice(2)).toEqual([
      "x-server",
      "window-manager",
      "clipboard",
      "browser",
    ]);
    expect(h.terminated()).toHaveLength(2);
  });

  test("an X server exit tears the tree down and tells the viewer", async () => {
    const h = newManager();
    const { viewer, lost } = newViewer();
    expect(h.manager.acquireViewerSlot(viewer)).toEqual({ ok: true });
    await h.manager.ensureDesktopRunning();
    await settle();

    h.child("x-server").exit(1);
    await settle();

    expect(lost).toEqual([
      { code: 4011, reason: "Desktop stopped: x-server exited" },
    ]);
    expect(
      h
        .terminated()
        .map((c) => c.role)
        .sort(),
    ).toEqual(["browser", "clipboard", "window-manager"]);
    // The slot is free and the next start builds a fresh tree.
    expect(h.manager.acquireViewerSlot(newViewer().viewer)).toEqual({
      ok: true,
    });
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(2);
  });

  test("a browser exit with nobody watching keeps the desktop and the next viewer gets a fresh one", async () => {
    const h = newManager();
    await h.manager.ensureDesktopRunning();
    await settle();

    h.child("browser").exit(0);
    await settle();
    expect(h.killed).toEqual([]);
    expect(h.count("browser")).toBe(1);

    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.count("x-server")).toBe(1);
    expect(h.count("browser")).toBe(2);
  });

  test("a browser exit under a viewer relaunches it, until it crash loops", async () => {
    const h = newManager();
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    for (let exits = 1; exits <= 3; exits += 1) {
      h.child("browser").exit(1);
      await settle();
      expect(h.count("browser")).toBe(exits + 1);
      expect(lost).toEqual([]);
    }

    h.child("browser").exit(1);
    await settle();
    expect(h.count("browser")).toBe(4);
    expect(lost).toEqual([
      { code: 4011, reason: "Desktop browser keeps crashing" },
    ]);
    expect(
      h
        .terminated()
        .map((c) => c.role)
        .sort(),
    ).toEqual(["clipboard", "window-manager", "x-server"]);
  });

  test("a browser that cannot be installed takes the desktop down", async () => {
    const h = newManager();
    h.setChromiumPath(async () => {
      throw new Error("playwright install failed");
    });
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    expect(lost).toEqual([
      { code: 4011, reason: "Desktop browser failed to start" },
    ]);
    expect(h.terminated()).toHaveLength(3);
  });

  test("destroy terminates, hard-kills stragglers after the grace, and refuses what comes after", async () => {
    const h = newManager({ exitOnKill: true });
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    const started = Date.now();
    await Promise.all([h.manager.destroy(), h.manager.destroy()]);

    expect(Date.now() - started).toBeGreaterThanOrEqual(KILL_GRACE_MS - 2);
    expect(lost).toEqual([
      { code: 1001, reason: "The assistant is shutting down" },
    ]);
    expect(h.killed.map((k) => k.signal)).toEqual([
      ...Array(4).fill("SIGTERM"),
      ...Array(4).fill("SIGKILL"),
    ]);
    expect(h.manager.acquireViewerSlot(newViewer().viewer)).toEqual(
      SHUTTING_DOWN,
    );
    await expect(h.manager.ensureDesktopRunning()).rejects.toMatchObject({
      loss: SHUTTING_DOWN.loss,
    });
  });

  test("destroy skips the hard kill when every child exits on SIGTERM", async () => {
    const h = newManager({ exitOnTerm: true });
    await h.manager.ensureDesktopRunning();
    await settle();

    await h.manager.destroy();
    expect(h.killed.map((k) => k.signal)).toEqual(Array(4).fill("SIGTERM"));
  });
});

describe("DesktopSessionManager viewer slot", () => {
  test("holds one viewer and only the holder can release it", () => {
    const h = newManager();
    const first = newViewer().viewer;
    const second = newViewer().viewer;

    expect(h.manager.acquireViewerSlot(first)).toEqual({ ok: true });
    expect(h.manager.acquireViewerSlot(second)).toEqual(BUSY);

    h.manager.releaseViewerSlot(second);
    expect(h.manager.acquireViewerSlot(second)).toEqual(BUSY);

    h.manager.releaseViewerSlot(first);
    expect(h.manager.acquireViewerSlot(second)).toEqual({ ok: true });
  });

  test("the tree lingers after the last viewer leaves, then is torn down", async () => {
    const h = newManager();
    const { viewer } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    await settle();

    h.manager.releaseViewerSlot(viewer);
    expect(h.killed).toEqual([]);

    await sleep(LINGER_MS * 2);
    expect(h.terminated()).toHaveLength(4);
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(2);
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

    expect(h.killed).toEqual([]);
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(1);
  });
});
