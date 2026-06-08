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

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const {
  __resetForTesting,
  __setPlatformForTesting,
  getHotkeyHelperPath,
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

describe("getHotkeyHelperPath", () => {
  test("resolves dev helper from app path resources", () => {
    expect(getHotkeyHelperPath()).toBe(
      "/repo/apps/macos/resources/hotkey-helper",
    );
  });

  test("resolves packaged helper from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getHotkeyHelperPath()).toBe("/mock/resources/hotkey-helper");
  });
});

describe("installHotkeyHelper", () => {
  test("registers the fnPushToTalk IPC handler", () => {
    installHotkeyHelper();
    expect(handlers["vellum:helper:hotkey:fnPushToTalk"]).toBeDefined();
  });

  test("sends hotkey.fnPushToTalk to the helper process", async () => {
    installHotkeyHelper();
    const pending = invokeFnPushToTalk(true);

    expect(spawnCalls[0]?.[0]).toBe(
      "/repo/apps/macos/resources/hotkey-helper",
    );
    expect(lastChild?.stdin.writes[0]).toContain(
      "\"method\":\"hotkey.fnPushToTalk\"",
    );
    expect(lastChild?.stdin.writes[0]).toContain("\"enable\":true");

    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"id\":1,\"ok\":true,\"result\":{\"enabled\":true}}\n"),
    );

    expect(await pending).toEqual({ ok: true, enabled: true });
  });

  test("returns unavailable when the helper executable is missing", async () => {
    exists = false;
    installHotkeyHelper();

    expect(await invokeFnPushToTalk(true)).toEqual({
      ok: false,
      reason: "hotkey helper is not available",
    });
  });

  test("routes hotkey-event envelopes to the registered owner", async () => {
    installHotkeyHelper();

    const pending = invokeFnPushToTalk(true);
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        "{\"event\":\"hotkey-event\",\"payload\":{\"kind\":\"fnPushToTalk\",\"state\":\"down\"}}\n",
      ),
    );
    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"id\":1,\"ok\":true,\"result\":{\"enabled\":true}}\n"),
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
      Buffer.from("{\"id\":1,\"ok\":true,\"result\":{\"enabled\":true}}\n"),
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
        "{\"event\":\"hotkey-event\",\"payload\":{\"kind\":\"fnPushToTalk\",\"state\":\"down\"}}\n",
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
      Buffer.from("{\"id\":2,\"ok\":true,\"result\":{\"enabled\":false}}\n"),
    );
    expect(await firstDisable).toEqual({ ok: true, enabled: false });
  });

  test("closes helper stdin on app quit so native registrations are cleaned up", async () => {
    installHotkeyHelper();
    const pending = invokeFnPushToTalk(true);
    lastChild?.stdout.emit(
      "data",
      Buffer.from("{\"id\":1,\"ok\":true,\"result\":{\"enabled\":true}}\n"),
    );
    await pending;

    appListeners.get("will-quit")?.();

    expect(lastChild?.stdin.writes.at(-1)).toContain("\"enable\":false");
    expect(lastChild?.stdin.ended).toBe(true);
  });
});
