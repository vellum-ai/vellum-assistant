import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

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
import * as browserEndpoint from "./desktop-browser-endpoint.js";
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
const panelConfigDir = mkdtempSync(join(tmpdir(), "desktop-panel-test-"));
const managers: ReturnType<typeof newFakeDesktop>["manager"][] = [];
afterAll(async () => {
  await Promise.all(managers.map((manager) => manager.destroy()));
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(panelConfigDir, { recursive: true, force: true });
});

function newManager(
  options: Omit<FakeDesktopOptions, "profileDir" | "panelConfigDir"> = {},
) {
  const harness = newFakeDesktop({ profileDir, panelConfigDir, ...options });
  managers.push(harness.manager);
  return harness;
}

test("CPU budget wraps every desktop child including dock restarts", async () => {
  let preparations = 0;
  const h = newManager({
    exitOnTerm: true,
    panelRestartDelayMs: 1,
    renderWallpaper: async () => Buffer.from("wallpaper"),
    prepareCpuBudget: async () => {
      preparations++;
      return { wrapCommand: (command) => ["budget-launcher", ...command] };
    },
  });
  await h.manager.ensureDesktopRunning();
  await waitFor(() => h.count("browser") === 1 && h.count("wallpaper") === 1);
  h.child("panel").exit(1);
  await waitFor(() => h.count("panel") === 2);
  expect(preparations).toBe(1);
  expect(
    h.spawned.every((child) => child.request.cmd[0] === "budget-launcher"),
  ).toBe(true);
  await h.manager.destroy();
});

test("shutdown during CPU preparation cannot launch a delayed desktop", async () => {
  const preparing = Promise.withResolvers<{
    wrapCommand: (command: readonly string[]) => readonly string[];
  }>();
  const h = newManager({ prepareCpuBudget: () => preparing.promise });
  const started = h.manager.ensureDesktopRunning();
  await settle();
  await h.manager.destroy();
  preparing.resolve({ wrapCommand: (command) => command });
  await expect(started).rejects.toThrow("torn down");
  expect(h.spawned).toHaveLength(0);
});

describe("desktop wallpaper lifecycle", () => {
  test("applies the rendered wallpaper and refreshes it on reconnect without restarting X", async () => {
    let current = Buffer.from("first wallpaper");
    const h = newManager({
      renderWallpaper: async () => current,
      exitOnTerm: true,
    });
    await h.manager.ensureDesktopRunning();
    await settle();
    const path = join(panelConfigDir, "wallpaper.png");
    expect(readFileSync(path)).toEqual(current);
    expect(h.child("wallpaper").request.cmd).toEqual([
      "/usr/bin/feh",
      "--no-fehbg",
      "--bg-fill",
      path,
    ]);
    expect(h.child("wallpaper").request.env.DISPLAY).toBe(":99");
    h.child("wallpaper").exit(0);
    await settle();
    current = Buffer.from("updated avatar wallpaper");
    await h.manager.ensureDesktopRunning();
    await settle();
    expect(readFileSync(path)).toEqual(current);
    expect(h.count("wallpaper")).toBe(2);
    expect(h.count("x-server")).toBe(1);
    await h.manager.destroy();
  });

  test.each(["success", "failure"] as const)(
    "reconnects during a render queue the latest avatar after %s",
    async (outcome) => {
      let current = Buffer.from("first avatar");
      const pending: { finish: () => void; fail: () => void }[] = [];
      const h = newManager({
        renderWallpaper: () => {
          const snapshot = current;
          return new Promise((resolve, reject) => {
            pending.push({
              finish: () => resolve(snapshot),
              fail: () => reject(new Error("render failed")),
            });
          });
        },
        exitOnTerm: true,
      });
      try {
        await h.manager.ensureDesktopRunning();
        current = Buffer.from("second avatar");
        await h.manager.ensureDesktopRunning();
        current = Buffer.from("latest avatar");
        await h.manager.ensureDesktopRunning();
        expect(pending).toHaveLength(1);

        if (outcome === "success") {
          pending[0]!.finish();
        } else {
          pending[0]!.fail();
        }
        await settle();
        expect(pending).toHaveLength(2);
        expect(h.count("wallpaper")).toBe(0);

        pending[1]!.finish();
        await settle();
        expect(readFileSync(join(panelConfigDir, "wallpaper.png"))).toEqual(
          current,
        );
        expect(h.count("wallpaper")).toBe(1);
        expect(h.count("x-server")).toBe(1);
        expect(pending).toHaveLength(2);
      } finally {
        await h.manager.destroy();
      }
    },
  );

  test("pending and queued renders neither delay Chrome nor apply after shutdown", async () => {
    let finish!: (png: Buffer) => void;
    let renders = 0;
    const h = newManager({
      renderWallpaper: () => {
        renders++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      exitOnTerm: true,
    });
    await h.manager.ensureDesktopRunning();
    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.count("browser")).toBe(1);
    expect(renders).toBe(1);
    await h.manager.destroy();
    finish(Buffer.from("stale render"));
    await settle();
    expect(h.count("wallpaper")).toBe(0);
    expect(renders).toBe(1);
  });

  test.each(["render", "spawn", "exit"] as const)(
    "wallpaper %s failure leaves the viewer connected",
    async (failure) => {
      const h = newManager({
        renderWallpaper: async () => {
          if (failure === "render") {
            throw new Error("render failed");
          }
          return Buffer.from("wallpaper");
        },
        failSpawn: failure === "spawn" ? ["wallpaper"] : [],
        exitOnTerm: true,
      });
      const { viewer, lost } = newViewer();
      h.manager.acquireViewerSlot(viewer);
      await h.manager.ensureDesktopRunning();
      await settle();
      if (failure === "exit") {
        h.child("wallpaper").exit(1);
        await settle();
      }
      expect(lost).toEqual([]);
      expect(h.count("browser")).toBe(1);
      expect(h.terminated()).toEqual([]);
      await h.manager.destroy();
    },
  );
});

describe("DesktopSessionManager process tree", () => {
  test("concurrent callers share one start of the whole tree", async () => {
    const h = newManager({
      sourceEnv: {
        PATH: "/usr/bin",
        HOME: "/data",
        LANG: "C.UTF-8",
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

    // The dock waits on the Chromium path its launcher points at, so it comes
    // up alongside the browser rather than with the rest of the tree.
    expect(h.roles()).toEqual([
      "x-server",
      "window-manager",
      "compositor",
      "clipboard",
      "panel",
      "browser",
    ]);

    const x = h.child("x-server").request.cmd;
    expect(x.slice(0, 2)).toEqual(["/usr/bin/Xtigervnc", ":99"]);
    expect(x).toContain("-localhost");
    expect(x[x.indexOf("-SecurityTypes") + 1]).toBe("None");
    expect(x[x.indexOf("-rfbport") + 1]).toBe(String(DESKTOP_VNC_PORT));
    expect(x[x.indexOf("-geometry") + 1]).toBe("1600x900");
    for (const role of [
      "window-manager",
      "compositor",
      "clipboard",
      "browser",
    ] as const) {
      expect(h.child(role).request.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/data",
        LANG: "C.UTF-8",
        DISPLAY: ":99",
      });
    }
    expect(h.child("window-manager").request.cmd[0]).toBe("/usr/bin/python3");
    expect(h.child("window-manager").request.cmd.slice(3)).toEqual([
      "/usr/bin/openbox",
      "--sm-disable",
      "--config-file",
      join(panelConfigDir, "openbox.xml"),
    ]);
    // The compositor precedes the dock so it has an ARGB visual.
    expect(h.child("compositor").request.cmd).toEqual(["/usr/bin/xcompmgr"]);
    expect(h.child("panel").request.cmd).toEqual([
      "/usr/bin/dbus-run-session",
      "--",
      "/usr/bin/plank",
    ]);
    expect(h.child("panel").request.env).toEqual({
      ...h.child("browser").request.env,
      XDG_CONFIG_HOME: panelConfigDir,
      XDG_DATA_HOME: panelConfigDir,
      GSETTINGS_BACKEND: "keyfile",
    });
    expect(h.child("clipboard").request.cmd).toEqual([
      "/usr/bin/tigervncconfig",
      "-nowin",
    ]);
    const browser = h.child("browser").request.cmd;
    expect(browser[0]).toBe("/fake/chromium");
    expect(browser).toContain(`--user-data-dir=${profileDir}`);

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
      missingBinaries: [
        "Xtigervnc",
        "xcompmgr",
        "plank",
        "tigervncconfig",
        "vncconfig",
        "xterm",
      ],
    });
    await expect(h.manager.ensureDesktopRunning()).rejects.toThrow(
      "Desktop component is missing: Xtigervnc",
    );
    expect(h.spawned).toEqual([]);
  });

  test("the dock is generated with the resolved Chrome and terminal", async () => {
    const h = newManager();
    await h.manager.ensureDesktopRunning();
    await settle();

    const chromium = readFileSync(
      join(panelConfigDir, "applications", "google-chrome.desktop"),
      "utf8",
    );
    expect(chromium).toContain(`Exec="/fake/chromium"`);
    expect(chromium).toContain(`"--user-data-dir=${profileDir}"`);
    expect(chromium).toContain("Icon=/fake/product_logo_64.png");

    const terminal = readFileSync(
      join(panelConfigDir, "applications", "xterm.desktop"),
      "utf8",
    );
    expect(terminal).toContain(`Exec="/usr/bin/xterm"`);
    expect(terminal).toContain(`Icon=${join(panelConfigDir, "terminal.png")}`);

    const bytes = readFileSync(join(panelConfigDir, "terminal.png"));
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // A complete IEND chunk catches a truncated icon.
    expect([...bytes.subarray(-12)]).toEqual([
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
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
    ).toEqual(["compositor", "window-manager", "x-server"]);
    expect(lost).toEqual([{ code: 4011, reason: "Desktop failed to start" }]);

    failSpawn.length = 0;
    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.roles().slice(3)).toEqual([
      "x-server",
      "window-manager",
      "compositor",
      "clipboard",
      "panel",
      "browser",
    ]);
    expect(h.terminated()).toHaveLength(3);
  });

  test("a dock or compositor that will not spawn leaves the desktop up", async () => {
    const h = newManager({ failSpawn: ["compositor", "panel"] });
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);

    await h.manager.ensureDesktopRunning();
    await settle();

    expect(lost).toEqual([]);
    expect(h.killed).toEqual([]);
    expect(h.roles()).toEqual([
      "x-server",
      "window-manager",
      "clipboard",
      "browser",
    ]);
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
    ).toEqual([
      "browser",
      "clipboard",
      "compositor",
      "panel",
      "window-manager",
    ]);
    // The slot is free and the next start builds a fresh tree.
    expect(h.manager.acquireViewerSlot(newViewer().viewer)).toEqual({
      ok: true,
    });
    await h.manager.ensureDesktopRunning();
    expect(h.count("x-server")).toBe(2);
  });

  test("restarts the dock without interrupting its applications or the viewer", async () => {
    const h = newManager({ exitOnTerm: true, panelRestartDelayMs: 5 });
    const { viewer, lost } = newViewer();
    h.manager.acquireViewerSlot(viewer);
    await h.manager.ensureDesktopRunning();
    const firstPanel = h.child("panel");
    firstPanel.exit(1);
    await waitFor(() => h.count("panel") === 2);

    expect(lost).toEqual([]);
    expect(h.killed).toEqual([]);
    expect(h.count("x-server")).toBe(1);
    expect(h.count("browser")).toBe(1);

    await h.manager.destroy();
    for (const panel of [firstPanel, h.child("panel")]) {
      expect(h.killed.filter((k) => k.child === panel)).toEqual([
        { child: panel, signal: "SIGTERM" },
        { child: panel, signal: "SIGKILL" },
      ]);
    }
  });

  test("recovers from a transient dock startup failure", async () => {
    const failSpawn: DesktopChildRole[] = ["panel"];
    const h = newManager({ failSpawn, panelRestartDelayMs: 5 });
    await h.manager.ensureDesktopRunning();
    expect(h.count("panel")).toBe(0);
    failSpawn.length = 0;
    await waitFor(() => h.count("panel") === 1);
    expect(h.count("browser")).toBe(1);
    await h.manager.destroy();
  });

  test("bounds repeated dock failures without shutting down the desktop", async () => {
    const h = newManager({ panelRestartDelayMs: 5 });
    await h.manager.ensureDesktopRunning();
    for (let count = 2; count <= 4; count += 1) {
      h.child("panel").exit(1);
      await waitFor(() => h.count("panel") === count);
    }
    h.child("panel").exit(1);
    await sleep(30);
    expect(h.count("panel")).toBe(4);
    expect(h.killed).toEqual([]);
    expect(h.count("x-server")).toBe(1);
    await h.manager.destroy();
  });

  test("cancels a pending dock restart when the desktop shuts down", async () => {
    const h = newManager({ panelRestartDelayMs: 30 });
    await h.manager.ensureDesktopRunning();
    h.child("panel").exit(1);
    await settle();
    await h.manager.destroy();
    await sleep(40);
    expect(h.count("panel")).toBe(1);
  });

  test("a browser closed without a viewer stays closed when a viewer connects", async () => {
    const h = newManager({ exitOnTerm: true });
    await h.manager.ensureDesktopRunning();
    await settle();

    h.child("browser").exit(0);
    await settle();
    expect(h.killed).toEqual([]);
    expect(h.count("browser")).toBe(1);

    h.manager.acquireViewerSlot(newViewer().viewer);
    await h.manager.ensureDesktopRunning();
    await settle();
    expect(h.count("x-server")).toBe(1);
    expect(h.count("browser")).toBe(1);
    expect(h.killed).toEqual([]);
    await h.manager.destroy();
  });

  test.each(["Default", "Profile 1"])(
    "restores a crashed %s session but preserves a subsequent clean close",
    async (profileName) => {
      const dir = mkdtempSync(join(tmpdir(), "desktop-crash-test-"));
      let h = newFakeDesktop({ profileDir: dir, exitOnTerm: true });
      try {
        mkdirSync(join(dir, profileName));
        writeFileSync(
          join(dir, "Local State"),
          JSON.stringify({ profile: { last_used: profileName } }),
        );
        const preferences = join(dir, profileName, "Preferences");
        const original = {
          profile: { exit_type: "Crashed" },
          browser: { custom_chrome_frame: false, show_home_button: true },
          session: { restore_on_startup: 1 },
        };
        const crashed = JSON.stringify(original);
        writeFileSync(preferences, crashed);
        h.manager.acquireViewerSlot(newViewer().viewer);
        await h.manager.ensureDesktopRunning();
        expect(h.child("browser").request.cmd).toContain(
          "--restore-last-session",
        );
        expect(h.child("browser").request.cmd).toContain(
          "--hide-crash-restore-bubble",
        );
        expect(JSON.parse(readFileSync(preferences, "utf8"))).toEqual({
          ...original,
          browser: { ...original.browser, custom_chrome_frame: true },
        });

        h.child("browser").exit(1);
        await settle();
        expect(h.count("browser")).toBe(1);
        await h.manager.destroy();
        h = newFakeDesktop({ profileDir: dir, exitOnTerm: true });
        await h.manager.ensureDesktopRunning();
        await settle();
        expect(h.child("browser").request.cmd).toContain(
          "--restore-last-session",
        );

        writeFileSync(
          preferences,
          JSON.stringify({ profile: { exit_type: "Normal" } }),
        );
        h.child("browser").exit(0);
        await settle();
        expect(h.count("browser")).toBe(1);
        await h.manager.destroy();
        h = newFakeDesktop({ profileDir: dir, exitOnTerm: true });
        await h.manager.ensureDesktopRunning();
        await settle();
        expect(h.child("browser").request.cmd).not.toContain(
          "--restore-last-session",
        );
        expect(h.child("browser").request.cmd).not.toContain(
          "--hide-crash-restore-bubble",
        );
      } finally {
        await h.manager.destroy();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each([0, 1])(
    "a browser exit (%s) keeps the desktop usable and stays closed on reconnect",
    async (exitCode) => {
      const h = newManager({ exitOnTerm: true });
      const { viewer, lost } = newViewer();
      h.manager.acquireViewerSlot(viewer);
      await h.manager.ensureDesktopRunning();
      await settle();

      h.child("browser").exit(exitCode);
      await settle();
      expect(h.count("browser")).toBe(1);
      expect(lost).toEqual([]);
      expect(h.killed).toEqual([]);

      h.manager.releaseViewerSlot(viewer);
      expect(h.manager.acquireViewerSlot(viewer)).toEqual({ ok: true });
      await h.manager.ensureDesktopRunning();
      await settle();
      expect(h.count("browser")).toBe(1);
      expect(h.count("x-server")).toBe(1);
      expect(h.count("panel")).toBe(1);
      expect(lost).toEqual([]);
      expect(h.killed).toEqual([]);
      await h.manager.destroy();
    },
  );

  test("a browser that cannot be resolved takes the desktop down", async () => {
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
    // The dock never got its Chromium path, so only the three fatal children
    // and no panel are killed.
    expect(
      h
        .terminated()
        .map((c) => c.role)
        .sort(),
    ).toEqual(["clipboard", "compositor", "window-manager", "x-server"]);
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
      ...Array(6).fill("SIGTERM"),
      ...Array(6).fill("SIGKILL"),
    ]);
    expect(h.manager.acquireViewerSlot(newViewer().viewer)).toEqual(
      SHUTTING_DOWN,
    );
    await expect(h.manager.ensureDesktopRunning()).rejects.toMatchObject({
      loss: SHUTTING_DOWN.loss,
    });
  });

  test("destroy still clears dock descendants when every direct child exits on SIGTERM", async () => {
    const h = newManager({ exitOnTerm: true });
    await h.manager.ensureDesktopRunning();
    await settle();

    await h.manager.destroy();
    expect(h.killed.filter((k) => k.signal === "SIGTERM")).toHaveLength(6);
    expect(h.killed.filter((k) => k.signal === "SIGKILL")).toEqual([
      { child: h.child("panel"), signal: "SIGKILL" },
    ]);
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
    expect(h.terminated()).toHaveLength(6);
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

describe("desktop automation lifecycle", () => {
  test("an automation session outlives viewer disconnect and idles after both release", async () => {
    const f = newManager({ exitOnTerm: true });
    const viewer = newViewer();
    const automation = newViewer();
    expect(f.manager.acquireViewerSlot(viewer.viewer)).toEqual({ ok: true });
    expect(f.manager.acquireAutomationSlot(automation.viewer)).toEqual({
      ok: true,
    });
    await f.manager.ensureDesktopRunning();
    f.manager.releaseViewerSlot(viewer.viewer);
    await sleep(LINGER_MS + 20);
    expect(f.terminated()).toHaveLength(0);
    f.manager.releaseAutomationSlot(automation.viewer);
    await waitFor(() => f.terminated().length > 0);
    await f.manager.destroy();
  });

  test("shutdown notifies both the viewer and automation owner", async () => {
    const f = newManager({ exitOnTerm: true });
    const viewer = newViewer();
    const automation = newViewer();
    f.manager.acquireViewerSlot(viewer.viewer);
    f.manager.acquireAutomationSlot(automation.viewer);
    await f.manager.ensureDesktopRunning();
    await f.manager.destroy();
    expect(viewer.lost[0]?.code).toBe(1001);
    expect(automation.lost[0]?.code).toBe(1001);
    expect(f.manager.acquireAutomationSlot(newViewer().viewer)).toEqual(
      SHUTTING_DOWN,
    );
  });
});

test.each([undefined, 4321])(
  "browser control uses the reopened dock PID %s or launches Chrome when absent",
  async (dockPid) => {
    const h = newManager({ exitOnTerm: true });
    const owner = newViewer().viewer;
    h.manager.acquireViewerSlot(owner);
    await h.manager.ensureDesktopRunning();
    await settle();
    h.child("browser").exit(0);
    await settle();
    h.manager.acquireAutomationSlot(owner);
    const abort = new AbortController();
    const find = spyOn(
      browserEndpoint,
      "findDesktopBrowserPid",
    ).mockResolvedValue(dockPid);
    const discover = spyOn(
      browserEndpoint,
      "discoverDesktopBrowser",
    ).mockImplementation(async () => {
      abort.abort();
      throw new Error("Reached verified discovery");
    });
    try {
      await expect(
        h.manager.browser.client("conv-123", abort.signal),
      ).rejects.toThrow("Reached verified discovery");
      expect(h.count("browser")).toBe(dockPid ? 1 : 2);
      expect(discover.mock.calls[0]?.[0]).toBe(
        dockPid ?? h.child("browser").pid,
      );
      expect(find).toHaveBeenCalledTimes(1);
    } finally {
      find.mockRestore();
      discover.mockRestore();
      await h.manager.destroy();
    }
  },
);
