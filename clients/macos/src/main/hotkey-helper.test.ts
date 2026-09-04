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

const appState = { isPackaged: false, appPath: "/repo/clients/macos" };
const handlers: Record<
  string,
  (event: unknown, ...args: unknown[]) => unknown
> = {};
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
// getMacHelperPath reads CFBundleExecutable from the bundle's Info.plist to
// resolve the (per-environment) executable filename. getMacHelperAppPath
// reads a sidecar (.vellum-mac-helper.bundle-name) to discover the .app
// folder name — the same pattern, lifted one level. The default bundle name
// is `vellum-mac-helper`, so tests that don't override it resolve the
// `vellum-mac-helper.app` path.
let helperExecutableName = "vellum-mac-helper";
let helperBundleName = "vellum-mac-helper";
mock.module("node:fs", () => ({
  existsSync: () => exists,
  readFileSync: (target: unknown) => {
    const targetPath = String(target);
    if (targetPath.endsWith(".vellum-mac-helper.bundle-name")) {
      return helperBundleName;
    }
    return `<plist><dict><key>CFBundleExecutable</key><string>${helperExecutableName}</string></dict></plist>`;
  },
}));

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

const { setPointerOnCompanion } = await import("./companion-pointer");

const {
  __resetForTesting,
  __setPlatformForTesting,
  __setSupervisorOptionsForTesting,
  installHotkeyHelper,
  queryFreshMacHelperPermission,
  requestMacHelperInputMonitoringPermission,
  requestMacHelperSpeechRecognitionPermission,
} = await import("./hotkey-helper");

const { getMacHelperAppPath, getMacHelperPath } =
  await import("./sidecar/mac-helper-path");

const CTRL_OPTION = { kind: "modifierOnly", modifiers: ["control", "option"] };

const invokeSetModifierHoldFrom = (hold: unknown, sender: FakeWebContents) =>
  handlers["vellum:helper:hotkey:setModifierHold"](
    { sender },
    hold,
  ) as Promise<unknown>;

const invokeSetModifierHold = (hold: unknown = CTRL_OPTION) =>
  invokeSetModifierHoldFrom(hold, defaultSender);

/**
 * Register the hold and answer the helper's reply. Registrations are chained,
 * so the request reaches the helper a tick after the call.
 */
const registerHold = async (
  sender: FakeWebContents = defaultSender,
  id = 1,
): Promise<unknown> => {
  const pending = invokeSetModifierHoldFrom(CTRL_OPTION, sender);
  await wait(5);
  lastChild?.stdout.emit(
    "data",
    Buffer.from(`{"jsonrpc":"2.0","id":${id},"result":{"enabled":true}}\n`),
  );
  return pending;
};

const invokeReadFrontSelection = () =>
  handlers["vellum:helper:hotkey:readFrontSelection"]({
    sender: defaultSender,
  }) as Promise<unknown>;

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
  helperExecutableName = "vellum-mac-helper";
  helperBundleName = "vellum-mac-helper";
  appState.isPackaged = false;
  appState.appPath = "/repo/clients/macos";
  nextWebContentsId = 1;
  defaultSender = makeWebContents();
  setPointerOnCompanion(false);
});

afterEach(() => {
  __resetForTesting();
});

describe("getMacHelperPath", () => {
  test("resolves dev helper app from app path resources", () => {
    expect(getMacHelperAppPath()).toBe(
      "/repo/clients/macos/resources/vellum-mac-helper.app",
    );
  });

  test("resolves dev helper from app path resources", () => {
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
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

  test("resolves the per-environment executable name from CFBundleExecutable", () => {
    helperExecutableName = "Vellum Helper Dev";
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/vellum-mac-helper.app/Contents/MacOS/Vellum Helper Dev",
    );
  });

  test("resolves the per-environment bundle folder name from the sidecar", () => {
    helperBundleName = "Vellum Helper Dev";
    expect(getMacHelperAppPath()).toBe(
      "/repo/clients/macos/resources/Vellum Helper Dev.app",
    );
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/Vellum Helper Dev.app/Contents/MacOS/vellum-mac-helper",
    );
  });

  test("resolves the packaged bundle folder name from the sidecar", () => {
    appState.isPackaged = true;
    helperBundleName = "Vellum Helper Staging";
    expect(getMacHelperAppPath()).toBe(
      "/mock/resources/bin/Vellum Helper Staging.app",
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
      "/repo/clients/macos/resources/vellum-mac-helper.app",
      "--args",
      "--permission-status",
    ]);
    expect(args[4]).toBe("speechRecognition");
    expect(args[5]).toBe("--status-output");
    expect(args[6]).toBeString();

    await writeFile(args[6]!, '{"status":"granted"}');
    lastChild?.emit("exit", 0);
    expect(await pending).toBe("granted");
  });

  test("launches the helper app for Speech Recognition prompts", async () => {
    const pending = requestMacHelperSpeechRecognitionPermission();

    expect(spawnCalls[0]?.[0]).toBe("open");
    expect(spawnCalls[0]?.[1]).toEqual([
      "-n",
      "/repo/clients/macos/resources/vellum-mac-helper.app",
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
      "/repo/clients/macos/resources/vellum-mac-helper.app",
      "--args",
      "--request-input-monitoring",
    ]);

    lastChild?.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("installHotkeyHelper", () => {
  test("registers the helper IPC handlers", () => {
    installHotkeyHelper();
    expect(handlers["vellum:helper:ping"]).toBeDefined();
    expect(handlers["vellum:helper:state:get"]).toBeDefined();
    expect(handlers["vellum:helper:restart"]).toBeDefined();
    expect(handlers["vellum:helper:hotkey:setModifierHold"]).toBeDefined();
    expect(handlers["vellum:helper:hotkey:readFrontSelection"]).toBeDefined();
  });

  test("pings the helper process", async () => {
    installHotkeyHelper();
    const pending = invokePing();

    expect(lastChild?.stdin.writes[0]).toContain('"jsonrpc":"2.0"');
    expect(lastChild?.stdin.writes[0]).toContain('"method":"ping"');

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
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
      "/repo/clients/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
  });

  test("user-initiated restart replaces an already-running helper", async () => {
    installHotkeyHelper();

    const pending = invokePing();
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
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

  test("sends hotkey.modifierHold to the helper process", async () => {
    installHotkeyHelper();
    const pending = invokeSetModifierHold();
    await wait(5);

    expect(spawnCalls[0]?.[0]).toBe(
      "/repo/clients/macos/resources/vellum-mac-helper.app/Contents/MacOS/vellum-mac-helper",
    );
    expect(lastChild?.stdin.writes[0]).toContain('"jsonrpc":"2.0"');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes[0]).toContain('"enable":true');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"modifiers":["control","option"]',
    );

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"enabled":true}}\n'),
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
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
    );
    expect(await pending).toBe("pong");

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await wait(5);

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
  });

  /**
   * The renderer registered once and is not told about the restart, so the
   * key would be dead until the next reload if main did not hand the new
   * helper the binding.
   */
  test("restores the hold after a helper crash", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const crashed = lastChild;
    crashed?.emit("close", 1, null);
    await wait(5);

    expect(spawnCalls).toHaveLength(2);
    expect(lastChild).not.toBe(crashed);
    expect(lastChild?.stdin.writes[0]).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes[0]).toContain('"enable":true');
    expect(lastChild?.stdin.writes[0]).toContain(
      '"modifiers":["control","option"]',
    );
  });

  test("maps JSON-RPC helper errors to hotkey results", async () => {
    installHotkeyHelper();
    const pending = invokeSetModifierHold();
    await wait(5);

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Carbon failed"}}\n',
      ),
    );

    expect(await pending).toEqual({ ok: false, reason: "Carbon failed" });
  });

  test("returns unavailable when the helper executable is missing", async () => {
    exists = false;
    installHotkeyHelper();

    expect(await invokeSetModifierHold()).toEqual({
      ok: false,
      reason: "mac helper is not available",
    });
  });

  test("routes hotkey-event envelopes to the registered owner", async () => {
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );

    expect(defaultSender.send).toHaveBeenCalledWith(
      "vellum:helper:hotkey:event",
      { kind: "modifierHold", state: "down" },
    );
  });

  test("carries the reason a hold closed through to the owner", async () => {
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"up","reason":"chord"}}\n',
      ),
    );

    expect(defaultSender.send).toHaveBeenCalledWith(
      "vellum:helper:hotkey:event",
      { kind: "modifierHold", state: "up", reason: "chord" },
    );
  });

  test("reads what is highlighted in the application in front", async () => {
    installHotkeyHelper();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"selection":{"text":"the powerhouse","truncated":false,"editable":true}}}\n',
      ),
    );

    expect(lastChild?.stdin.writes[0]).toContain('"method":"selection.read"');
    expect(await pending).toEqual({
      text: "the powerhouse",
      truncated: false,
      editable: true,
    });
  });

  test("reads a selection that says nothing about editability as read-only", async () => {
    installHotkeyHelper();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"selection":{"text":"the powerhouse","truncated":false}}}\n',
      ),
    );

    expect(await pending).toEqual({
      text: "the powerhouse",
      truncated: false,
      editable: false,
    });
  });

  test("reads nothing highlighted as no selection", async () => {
    installHotkeyHelper();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
    );

    expect(await pending).toBeNull();
  });

  test("reads a refused selection as no selection", async () => {
    installHotkeyHelper();

    const pending = invokeReadFrontSelection();
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no front app"}}\n',
      ),
    );

    expect(await pending).toBeNull();
  });

  test("asks the helper which of the named apps are running", async () => {
    installHotkeyHelper();

    const pending = handlers["vellum:helper:apps:running"](
      { sender: defaultSender },
      ["com.electron.wispr-flow", "com.example.other"],
    ) as Promise<unknown>;
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.running"');
    expect(lastChild?.stdin.writes[0]).toContain('"com.electron.wispr-flow"');
    // Only the claimant is asked about; the renderer does not enumerate the
    // desktop through this.
    expect(lastChild?.stdin.writes[0]).not.toContain('"com.example.other"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"running":["com.electron.wispr-flow"]}}\n',
      ),
    );

    expect(await pending).toEqual(["com.electron.wispr-flow"]);
  });

  test("reads a helper that cannot say as no apps running", async () => {
    installHotkeyHelper();

    const pending = handlers["vellum:helper:apps:running"](
      { sender: defaultSender },
      ["com.electron.wispr-flow"],
    ) as Promise<unknown>;
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no workspace"}}\n',
      ),
    );

    expect(await pending).toEqual([]);
  });

  test("asks nothing of the helper for an app outside the voice key's claimants", async () => {
    installHotkeyHelper();

    expect(
      await (handlers["vellum:helper:apps:quit"](
        { sender: defaultSender },
        "com.example.editor",
      ) as Promise<unknown>),
    ).toBe(false);
    expect(lastChild).toBeNull();
    expect(
      await (handlers["vellum:helper:apps:running"]({ sender: defaultSender }, [
        "com.example.editor",
      ]) as Promise<unknown>),
    ).toEqual([]);
    expect(lastChild).toBeNull();
  });

  test("reads the application in front from the helper", async () => {
    installHotkeyHelper();

    const pending = handlers["vellum:helper:apps:frontmost"]({
      sender: defaultSender,
    }) as Promise<unknown>;
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.frontmost"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"bundleId":"com.example.editor"}}\n',
      ),
    );

    expect(await pending).toBe("com.example.editor");
  });

  /**
   * A press on the companion's own controls is not an edit in the user's
   * document, and the offer those controls answer must survive being pressed.
   */
  test("keeps a press on the companion out of the input activity it forwards", async () => {
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });
    setPointerOnCompanion(true);

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).not.toHaveBeenCalledWith(
      "vellum:helper:input:activity",
    );

    setPointerOnCompanion(false);
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).toHaveBeenCalledWith(
      "vellum:helper:input:activity",
    );
  });

  /**
   * The watch goes down with the helper the binding did, and the renderer
   * asks for neither again.
   */
  test("restores the input watch after a helper crash", async () => {
    __setSupervisorOptionsForTesting({ initialBackoffMs: 1, maxBackoffMs: 1 });
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const watch = handlers["vellum:helper:input:setActivityWatch"](
      { sender: defaultSender },
      true,
    ) as Promise<unknown>;
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"enabled":true}}\n'),
    );
    expect(await watch).toBe(true);

    lastChild?.emit("close", 1, null);
    await wait(10);

    const writes = lastChild?.stdin.writes.join("") ?? "";
    expect(writes).toContain('"method":"input.setActivityWatch"');
    expect(writes).toContain('"enable":true');
  });

  test("forwards input activity to the window that holds the key", async () => {
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    const pending = handlers["vellum:helper:input:setActivityWatch"](
      { sender: defaultSender },
      true,
    ) as Promise<unknown>;
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"enabled":true}}\n'),
    );
    expect(await pending).toBe(true);

    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","method":"input.activity"}\n'),
    );
    expect(defaultSender.send).toHaveBeenCalledWith(
      "vellum:helper:input:activity",
    );
  });

  test("asks the helper to quit an app and reports whether it was asked", async () => {
    installHotkeyHelper();

    const pending = handlers["vellum:helper:apps:quit"](
      { sender: defaultSender },
      "com.electron.wispr-flow",
    ) as Promise<unknown>;
    expect(lastChild?.stdin.writes[0]).toContain('"method":"apps.quit"');
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"asked":true}}\n'),
    );

    expect(await pending).toBe(true);
  });

  /**
   * The hold's consumer is a microphone that closes on the `up` of the binding
   * that opened it, so the edge a dead helper owes has to be that binding's,
   * and has to say the user did not let go.
   */
  test("closes a hold the helper died holding with a cancelled edge", async () => {
    __setSupervisorOptionsForTesting({
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    installHotkeyHelper();
    expect(await registerHold()).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );
    lastChild?.emit("close", 1, null);
    await wait(5);

    expect(defaultSender.send).toHaveBeenLastCalledWith(
      "vellum:helper:hotkey:event",
      { kind: "modifierHold", state: "up", reason: "cancelled" },
    );
  });

  test("the edges reach the window that registered last, and never a stranger", async () => {
    installHotkeyHelper();
    const first = makeWebContents();
    const second = makeWebContents();

    expect(await registerHold(first)).toEqual({ ok: true, enabled: true });
    expect(await registerHold(second, 2)).toEqual({ ok: true, enabled: true });

    lastChild?.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"hotkey.event","params":{"kind":"modifierHold","state":"down"}}\n',
      ),
    );
    expect(second.send).toHaveBeenCalledWith("vellum:helper:hotkey:event", {
      kind: "modifierHold",
      state: "down",
    });
    expect(first.send).not.toHaveBeenCalled();
    expect(defaultSender.send).not.toHaveBeenCalled();
  });

  /**
   * A window going away takes its ownership with it, and the binding comes
   * down only with the last of them: a hold armed in the helper with no
   * window left would open a microphone into nothing.
   */
  test("clears the hold when the last owner goes away, not before", async () => {
    installHotkeyHelper();
    const first = makeWebContents();
    const second = makeWebContents();

    expect(await registerHold(first)).toEqual({ ok: true, enabled: true });
    expect(await registerHold(second, 2)).toEqual({ ok: true, enabled: true });
    const writesBefore = lastChild?.stdin.writes.length;

    first.emit("destroyed");
    await wait(5);
    expect(lastChild?.stdin.writes.length).toBe(writesBefore);

    second.emit("destroyed");
    await wait(5);
    expect(lastChild?.stdin.writes.at(-1)).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes.at(-1)).toContain('"enable":false');
  });

  test("closes helper stdin on app quit so native registrations are cleaned up", async () => {
    installHotkeyHelper();
    await registerHold();

    appListeners.get("before-quit")?.();

    expect(lastChild?.stdin.writes.at(-1)).toContain(
      '"method":"hotkey.modifierHold"',
    );
    expect(lastChild?.stdin.writes.at(-1)).toContain('"enable":false');
    expect(lastChild?.stdin.ended).toBe(true);
  });

  test("does not respawn the helper after deliberate shutdown", async () => {
    installHotkeyHelper();
    const pending = invokePing();
    lastChild?.stdout.emit(
      "data",
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":"pong"}\n'),
    );
    await pending;

    const shuttingDown = lastChild;
    appListeners.get("before-quit")?.();
    shuttingDown?.emit("close", 0, null);

    await expect(invokePing()).rejects.toThrow("mac helper is not available");
    expect(spawnCalls).toHaveLength(1);
  });
});
