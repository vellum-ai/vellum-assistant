import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

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

type HotkeysSetting = Record<string, string | Record<string, unknown>>;

let hotkeysSetting: HotkeysSetting = {};
const settingsListeners = new Set<
  (newValue: HotkeysSetting, oldValue: HotkeysSetting) => void
>();

mock.module("./settings", () => ({
  readSetting: (key: string) => (key === "hotkeys" ? hotkeysSetting : null),
  writeSetting: (key: string, value: unknown) => {
    if (key !== "hotkeys") return;
    const oldValue = hotkeysSetting;
    hotkeysSetting = value as HotkeysSetting;
    for (const listener of settingsListeners) {
      listener(hotkeysSetting, oldValue);
    }
  },
  onSettingChange: (
    key: string,
    callback: (newValue: HotkeysSetting, oldValue: HotkeysSetting) => void,
  ) => {
    if (key !== "hotkeys") return () => undefined;
    settingsListeners.add(callback);
    return () => {
      settingsListeners.delete(callback);
    };
  },
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const {
  __resetForTesting,
  __setPlatformForTesting,
  __setSupervisorOptionsForTesting,
  getMacHelperPath,
  installHotkeyHelper,
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

const invokePttGetConfig = () =>
  handlers["vellum:ptt:getConfig"]({ sender: defaultSender }) as unknown;

const invokePttGetConfigState = () =>
  handlers["vellum:ptt:getConfigState"]({ sender: defaultSender }) as unknown;

const invokePttSetConfig = (config: unknown) =>
  handlers["vellum:ptt:setConfig"](
    { sender: defaultSender },
    config,
  ) as unknown;

const invokePttConfigure = (
  config: unknown,
  sender: FakeWebContents = defaultSender,
) =>
  handlers["vellum:ptt:configure"](
    { sender },
    config,
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
  hotkeysSetting = {};
  settingsListeners.clear();
  nextWebContentsId = 1;
  defaultSender = makeWebContents();
});

afterEach(() => {
  __resetForTesting();
});

describe("getMacHelperPath", () => {
  test("resolves dev helper from app path resources", () => {
    expect(getMacHelperPath()).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper",
    );
  });

  test("resolves packaged helper from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getMacHelperPath()).toBe(
      "/mock/resources/bin/vellum-mac-helper",
    );
  });
});

describe("installHotkeyHelper", () => {
  test("registers the fnPushToTalk IPC handler", () => {
    installHotkeyHelper();
    expect(handlers["vellum:helper:ping"]).toBeDefined();
    expect(handlers["vellum:helper:state:get"]).toBeDefined();
    expect(handlers["vellum:helper:restart"]).toBeDefined();
    expect(handlers["vellum:ptt:getConfig"]).toBeDefined();
    expect(handlers["vellum:ptt:getConfigState"]).toBeDefined();
    expect(handlers["vellum:ptt:setConfig"]).toBeDefined();
    expect(handlers["vellum:ptt:configure"]).toBeDefined();
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
      "/repo/apps/macos/resources/vellum-mac-helper",
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
      "/repo/apps/macos/resources/vellum-mac-helper",
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

  test("reads and writes structured push-to-talk config", () => {
    installHotkeyHelper();

    expect(invokePttGetConfig()).toEqual({
      kind: "modifierOnly",
      modifiers: ["function"],
    });
    expect(invokePttGetConfigState()).toEqual({
      config: { kind: "modifierOnly", modifiers: ["function"] },
      isStored: false,
    });

    expect(invokePttSetConfig({ kind: "mouseButton", button: 4 })).toEqual({
      kind: "mouseButton",
      button: 4,
    });
    expect(hotkeysSetting.ptt).toEqual({ kind: "mouseButton", button: 4 });
    expect(invokePttGetConfig()).toEqual({ kind: "mouseButton", button: 4 });
    expect(invokePttGetConfigState()).toEqual({
      config: { kind: "mouseButton", button: 4 },
      isStored: true,
    });
  });

  test("configures generic push-to-talk through the helper process", async () => {
    installHotkeyHelper();
    const pending = invokePttConfigure({ kind: "mouseButton", button: 4 });

    expect(spawnCalls[0]?.[0]).toBe(
      "/repo/apps/macos/resources/vellum-mac-helper",
    );
    expect(lastChild?.stdin.writes[0]).toContain("\"jsonrpc\":\"2.0\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"method\":\"ptt.setConfig\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"kind\":\"mouseButton\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"button\":4");

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );

    expect(await pending).toEqual({
      ok: true,
      enabled: true,
      config: { kind: "mouseButton", button: 4 },
    });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"method\":\"ptt.event\",\"params\":{\"state\":\"down\"}}\n",
      ),
    );

    expect(defaultSender.send).toHaveBeenCalledWith("vellum:ptt:state", {
      state: "down",
    });

    const disabled = invokePttConfigure({ kind: "none" });
    expect(lastChild?.stdin.writes.at(-1)).toContain("\"kind\":\"none\"");
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"enabled\":false}}\n",
      ),
    );

    expect(await disabled).toEqual({
      ok: true,
      enabled: false,
      config: { kind: "none" },
    });
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

  test("restores generic push-to-talk after a helper crash", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    installHotkeyHelper();

    const pending = invokePttConfigure({ kind: "mouseButton", button: 4 });
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"enabled\":true}}\n",
      ),
    );
    expect(await pending).toEqual({
      ok: true,
      enabled: true,
      config: { kind: "mouseButton", button: 4 },
    });

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await wait(5);

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
    expect(lastChild?.stdin.writes[0]).toContain("\"method\":\"ptt.setConfig\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"kind\":\"mouseButton\"");
    expect(lastChild?.stdin.writes[0]).toContain("\"button\":4");
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
