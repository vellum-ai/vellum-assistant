import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { FakeChild } from "./test-helpers";

class FakeHotkeyChild extends FakeChild {
  stdin = {
    writes: [] as string[],
    ended: false,
    write: mock((data: string, callback?: (err?: Error) => void) => {
      this.stdin.writes.push(data);
      callback?.();
      return true;
    }),
    end: mock(() => {
      this.stdin.ended = true;
    }),
  };
  kill = mock(() => true);
}

const appState = { isPackaged: false, appPath: "/repo/apps/macos" };
const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> =
  {};
const appListeners = new Map<string, () => void>();

type FakeWebContents = EventEmitter & {
  id: number;
  isDestroyed: () => boolean;
  ownerWindow: EventEmitter;
  send: ReturnType<typeof mock>;
};

let nextWebContentsId = 1;

const makeWebContents = (): FakeWebContents => {
  const webContents = new EventEmitter() as FakeWebContents;
  webContents.id = nextWebContentsId++;
  webContents.isDestroyed = () => false;
  webContents.ownerWindow = new EventEmitter();
  webContents.send = mock(() => undefined);
  return webContents;
};

let defaultSender = makeWebContents();

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getAppPath: () => appState.appPath,
    on: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
  BrowserWindow: {
    fromWebContents: (webContents: FakeWebContents) => webContents.ownerWindow,
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers[channel] = handler;
    },
    on: mock(() => undefined),
    removeAllListeners: mock(() => undefined),
  },
}));

let exists = true;
mock.module("node:fs", () => ({ existsSync: () => exists }));

let lastChild: FakeHotkeyChild | null = null;
const spawnCalls: Array<[string, string[], object]> = [];
mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: object) => {
    spawnCalls.push([cmd, args, opts]);
    lastChild = new FakeHotkeyChild();
    return lastChild;
  },
}));

mock.module("./logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module("./app-origin", () => ({
  isAllowedOrigin: () => true,
  resolveAllowedOrigin: () => ({ protocol: "app:", host: "vellum.ai" }),
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const {
  __resetForTesting,
  __setPlatformForTesting,
  __setSupervisorOptionsForTesting,
  getMacHelperAppPath,
  getMacHelperPath,
  installHotkeyHelper,
  queryFreshMacHelperPermission,
  requestMacHelperInputMonitoringPermission,
  requestMacHelperSpeechRecognitionPermission,
} = await import("./hotkey-helper");

const invokeFnPushToTalk = (enable: boolean) =>
  handlers["vellum:helper:hotkey:fnPushToTalk"](
    { sender: defaultSender },
    enable,
  ) as Promise<unknown>;

const invokeFnPushToTalkFrom = (enable: boolean, sender: FakeWebContents) =>
  handlers["vellum:helper:hotkey:fnPushToTalk"](
    { sender },
    enable,
  ) as Promise<unknown>;

const invokePing = () =>
  handlers["vellum:helper:ping"]({ sender: defaultSender }) as Promise<unknown>;

const invokeGetState = () =>
  handlers["vellum:helper:state:get"]({ sender: defaultSender }) as unknown;

const invokeRestart = () =>
  handlers["vellum:helper:restart"]({ sender: defaultSender }) as unknown;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  __resetForTesting();
  __setPlatformForTesting("darwin");
  for (const key of Object.keys(handlers)) delete handlers[key];
  appListeners.clear();
  spawnCalls.length = 0;
  lastChild = null;
  exists = true;
  appState.isPackaged = false;
  appState.appPath = "/repo/apps/macos";
  nextWebContentsId = 1;
  defaultSender = makeWebContents();
});

afterEach(() => {
  __resetForTesting();
});

describe("getMacHelperPath", () => {
  test("resolves dev helper app from app path resources", () => {
    expect(getMacHelperAppPath()).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper.app",
    );
  });

  test("resolves dev helper from app path resources", () => {
    expect(getMacHelperPath()).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
  });

  test("resolves packaged helper app from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getMacHelperAppPath()).toBe(
      "/mock/resources/bin/vellum-mac-helper.app",
    );
  });

  test("resolves packaged helper from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getMacHelperPath()).toBe(
      "/mock/resources/bin/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
  });
});

describe("permission request launchers", () => {
  test("reads a permission status from a fresh helper process", async () => {
    const pending = queryFreshMacHelperPermission("speechRecognition");
    await wait(10);

    expect(spawnCalls[0]?.[0]).toBe("open");
    const args = spawnCalls[0]?.[1] ?? [];
    expect(args.slice(0, 4)).toEqual([
      "-n",
      "/repo/apps/macos/resources/vellum-mac-helper.app",
      "--args",
      "--permission-status",
    ]);
    expect(args[4]).toBe("speechRecognition");
    expect(args[5]).toBe("--status-output");
    expect(args[6]).toBeString();

    await writeFile(args[6]!, "{\"status\":\"granted\"}");
    lastChild?.emit("exit", 0);
    expect(await pending).toBe("granted");
  });

  test("launches the helper app for Speech Recognition prompts", async () => {
    const pending = requestMacHelperSpeechRecognitionPermission();

    expect(spawnCalls[0]?.[0]).toBe("open");
    expect(spawnCalls[0]?.[1]).toEqual([
      "-n",
      "/repo/apps/macos/resources/vellum-mac-helper.app",
      "--args",
      "--request-speech-recognition",
    ]);

    lastChild?.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
  });

  test("launches the helper app for Input Monitoring prompts", async () => {
    const pending = requestMacHelperInputMonitoringPermission();

    expect(spawnCalls[0]?.[0]).toBe("open");
    expect(spawnCalls[0]?.[1]).toEqual([
      "-n",
      "/repo/apps/macos/resources/vellum-mac-helper.app",
      "--args",
      "--request-input-monitoring",
    ]);

    lastChild?.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("installHotkeyHelper", () => {
  test("registers the fnPushToTalk IPC handler", () => {
    installHotkeyHelper();
    expect(handlers["vellum:helper:ping"]).toBeDefined();
    expect(handlers["vellum:helper:state:get"]).toBeDefined();
    expect(handlers["vellum:helper:restart"]).toBeDefined();
    expect(handlers["vellum:helper:hotkey:fnPushToTalk"]).toBeDefined();
  });

  test("pings the helper process", async () => {
    installHotkeyHelper();
    const pending = invokePing();

    expect(lastChild?.stdin.writes[0]).toContain("\"jsonrpc\":\"2.0\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"method\":\"ping\"");

    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"pong\"}\n"),
    );

    expect(await pending).toBe("pong");
  });

  test("exposes helper state and user-initiated restart", () => {
    installHotkeyHelper();

    expect(invokeGetState()).toEqual({ status: "idle" });

    expect(invokeRestart()).toEqual({
      ok: true,
      state: { status: "running" },
    });
    expect(spawnCalls[0]?.[0]).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
  });

  test("user-initiated restart replaces an already-running helper", async () => {
    installHotkeyHelper();

    const pending = invokePing();
    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"pong\"}\n"),
    );
    expect(await pending).toBe("pong");

    const original = lastChild;
    expect(invokeRestart()).toEqual({
      ok: true,
      state: { status: "running" },
    });

    expect(original?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(original);
  });

  test("user-initiated restart reopens a circuit-open helper", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      circuitCrashCount: 2,
      circuitWindowMs: 1_000,
    });
    installHotkeyHelper();

    expect(invokeRestart()).toEqual({
      ok: true,
      state: { status: "running" },
    });

    const first = lastChild;
    first?.emit("close", 1, null);
    await wait(5);
    expect(spawnCalls).toHaveLength(2);

    const second = lastChild;
    second?.emit("close", 1, null);
    await wait(0);
    expect(invokeGetState()).toEqual(
      expect.objectContaining({ status: "circuit-open" }),
    );

    expect(invokeRestart()).toEqual({
      ok: true,
      state: { status: "running" },
    });
    expect(spawnCalls).toHaveLength(3);
  });

  test("sends hotkey.fnPushToTalk to the helper process", async () => {
    installHotkeyHelper();
    const pending = invokeFnPushToTalk(true);

    expect(spawnCalls[0]?.[0]).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
    expect(lastChild?.stdin.writes[0]).toContain("\"jsonrpc\":\"2.0\"");
    expect(lastChild?.stdin.writes[0]).toContain(
      "\"method\":\"hotkey.fnPushToTalk\"",
    );
    expect(lastChild?.stdin.writes[0]).toContain("\"enable\":true");

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );

    expect(await pending).toEqual({ ok: true, enabled: true });
  });

  test("restarts the helper after a crash", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    installHotkeyHelper();

    const pending = invokePing();
    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"pong\"}\n"),
    );
    expect(await pending).toBe("pong");

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await wait(5);

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
  });

  test("restores Fn push-to-talk after a helper crash", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    installHotkeyHelper();

    const pending = invokeFnPushToTalk(true);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );
    expect(await pending).toEqual({ ok: true, enabled: true });

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await wait(5);

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
    expect(lastChild?.stdin.writes[0]).toContain(
      "\"method\":\"hotkey.fnPushToTalk\"",
    );
    expect(lastChild?.stdin.writes[0]).toContain("\"enable\":true");
  });

  test("maps JSON-RPC helper errors to hotkey results", async () => {
    installHotkeyHelper();
    const pending = invokeFnPushToTalk(true);

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"Carbon failed\"}}\n",
      ),
    );

    expect(await pending).toEqual({ ok: false, reason: "Carbon failed" });
  });

  test("returns unavailable when the helper executable is missing", async () => {
    exists = false;
    installHotkeyHelper();

    expect(await invokeFnPushToTalk(true)).toEqual({
      ok: false,
      reason: "mac helper is not available",
    });
  });

  test("routes hotkey-event envelopes to the registered owner", async () => {
    installHotkeyHelper();

    const pending = invokeFnPushToTalk(true);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"method\":\"hotkey.event\",\"params\":{\"kind\":\"fnPushToTalk\",\"state\":\"down\"}}\n",
      ),
    );
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );

    expect(await pending).toEqual({ ok: true, enabled: true });
    expect(defaultSender.send).toHaveBeenCalledWith(
      "vellum:helper:hotkey:event",
      {
        kind: "fnPushToTalk",
        state: "down",
      },
    );
  });

  test("keeps the helper enabled while another owner remains", async () => {
    installHotkeyHelper();
    const first = makeWebContents();
    const second = makeWebContents();

    const firstEnable = invokeFnPushToTalkFrom(true, first);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );
    expect(await firstEnable).toEqual({ ok: true, enabled: true });

    expect(await invokeFnPushToTalkFrom(true, second)).toEqual({
      ok: true,
      enabled: true,
    });
    const writesAfterSecondOwner = lastChild?.stdin.writes.length;

    expect(await invokeFnPushToTalkFrom(false, second)).toEqual({
      ok: true,
      enabled: true,
    });
    expect(lastChild?.stdin.writes.length).toBe(writesAfterSecondOwner);

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"method\":\"hotkey.event\",\"params\":{\"kind\":\"fnPushToTalk\",\"state\":\"down\"}}\n",
      ),
    );
    expect(first.send).toHaveBeenCalledWith("vellum:helper:hotkey:event", {
      kind: "fnPushToTalk",
      state: "down",
    });
    expect(second.send).not.toHaveBeenCalled();

    const firstDisable = invokeFnPushToTalkFrom(false, first);
    expect(lastChild?.stdin.writes.at(-1)).toContain("\"enable\":false");
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"enabled\":false}}\n",
      ),
    );
    expect(await firstDisable).toEqual({ ok: true, enabled: false });
  });

  test("re-enables Fn push-to-talk when a new owner appears during disable", async () => {
    installHotkeyHelper();
    const first = makeWebContents();
    const second = makeWebContents();

    const firstEnable = invokeFnPushToTalkFrom(true, first);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );
    expect(await firstEnable).toEqual({ ok: true, enabled: true });

    const firstDisable = invokeFnPushToTalkFrom(false, first);
    expect(lastChild?.stdin.writes.at(-1)).toContain("\"enable\":false");

    const secondEnable = invokeFnPushToTalkFrom(true, second);
    expect(lastChild?.stdin.writes).toHaveLength(2);

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"enabled\":false}}\n",
      ),
    );
    await wait(0);

    expect(lastChild?.stdin.writes).toHaveLength(3);
    expect(lastChild?.stdin.writes.at(-1)).toContain("\"enable\":true");
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"enabled\":true}}\n",
      ),
    );

    expect(await firstDisable).toEqual({ ok: true, enabled: true });
    expect(await secondEnable).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"method\":\"hotkey.event\",\"params\":{\"kind\":\"fnPushToTalk\",\"state\":\"down\"}}\n",
      ),
    );
    expect(second.send).toHaveBeenCalledWith("vellum:helper:hotkey:event", {
      kind: "fnPushToTalk",
      state: "down",
    });
  });

  test("closes helper stdin on app quit so native registrations are cleaned up", async () => {
    installHotkeyHelper();
    const pending = invokeFnPushToTalk(true);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );
    await pending;

    appListeners.get("before-quit")?.();

    expect(lastChild?.stdin.writes.at(-1)).toContain("\"enable\":false");
    expect(lastChild?.stdin.ended).toBe(true);
  });

  test("does not respawn the helper after deliberate shutdown", async () => {
    installHotkeyHelper();
    const pending = invokePing();
    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"pong\"}\n"),
    );
    await pending;

    const shuttingDown = lastChild;
    appListeners.get("before-quit")?.();
    shuttingDown?.emit("close", 0, null);

    await expect(invokePing()).rejects.toThrow(
      "mac helper is not available",
    );
    expect(spawnCalls).toHaveLength(1);
  });
});
