import { describe, expect, test } from "bun:test";

import {
  type BrowserBackend,
  BrowserSessionManager,
  type CdpCommand,
  type CdpResult,
  createExtensionBackend,
  createLocalBackend,
} from "../index.js";

interface MockBackendState {
  available: boolean;
  disposed: boolean;
  lastCommand?: CdpCommand;
  lastSignal?: AbortSignal;
  sendImpl?: (command: CdpCommand, signal?: AbortSignal) => Promise<CdpResult>;
}

function createMockExtensionBackend(state: MockBackendState): BrowserBackend {
  return createExtensionBackend({
    isAvailable: () => state.available,
    sendCdp: async (command, signal) => {
      state.lastCommand = command;
      state.lastSignal = signal;
      if (state.sendImpl) return state.sendImpl(command, signal);
      return { result: { ok: true } };
    },
    dispose: () => {
      state.disposed = true;
    },
  });
}

function createMockLocalBackend(state: MockBackendState): BrowserBackend {
  return createLocalBackend({
    isAvailable: () => state.available,
    sendCdp: async (command, signal) => {
      state.lastCommand = command;
      state.lastSignal = signal;
      if (state.sendImpl) return state.sendImpl(command, signal);
      return { result: { ok: true, kind: "local" } };
    },
    dispose: () => {
      state.disposed = true;
    },
  });
}

describe("BrowserSessionManager", () => {
  test("selectBackend throws when no backend is available", () => {
    const state: MockBackendState = { available: false, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    expect(() => manager.selectBackend()).toThrow(
      "No available browser backend",
    );
  });

  test("selectBackend returns the extension backend when available", () => {
    const state: MockBackendState = { available: true, disposed: false };
    const backend = createMockExtensionBackend(state);
    const manager = new BrowserSessionManager({ backends: [backend] });
    const selected = manager.selectBackend();
    expect(selected.kind).toBe("extension");
    expect(selected).toBe(backend);
  });

  test("createSession returns a session with a new uuid stored in the map", () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const session = manager.createSession();
    expect(session.id).toBeTruthy();
    expect(session.backendKind).toBe("extension");
    // Lookup round-trips.
    expect(manager.getSession(session.id)).toEqual(session);
    // Two sessions get unique ids.
    const another = manager.createSession();
    expect(another.id).not.toBe(session.id);
  });

  test("send delegates to backend.send and returns the CDP result", async () => {
    const expectedResult: CdpResult = { result: { value: 42 } };
    const state: MockBackendState = {
      available: true,
      disposed: false,
      sendImpl: async () => expectedResult,
    };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const result = await manager.send(undefined, {
      method: "Browser.getVersion",
      params: { foo: "bar" },
    });
    expect(result).toEqual(expectedResult);
    expect(state.lastCommand).toEqual({
      method: "Browser.getVersion",
      params: { foo: "bar" },
    });
  });

  test("send with an aborted signal propagates the abort", async () => {
    const state: MockBackendState = {
      available: true,
      disposed: false,
      sendImpl: async (_command, signal) => {
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        return { result: { ok: true } };
      },
    };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.send(
        undefined,
        { method: "Browser.getVersion" },
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
    expect(state.lastSignal).toBe(controller.signal);
  });

  test("disposeAll calls backend.dispose and clears the session map", () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const session = manager.createSession();
    expect(manager.getSession(session.id)).toBeDefined();
    manager.disposeAll();
    expect(state.disposed).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
  });

  test("send with a known sessionId routes through the matching backend", async () => {
    const expectedResult: CdpResult = { result: { routed: true } };
    const state: MockBackendState = {
      available: true,
      disposed: false,
      sendImpl: async () => expectedResult,
    };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const session = manager.createSession();
    const result = await manager.send(session.id, {
      method: "Browser.getVersion",
    });
    expect(result).toEqual(expectedResult);
    expect(state.lastCommand).toEqual({ method: "Browser.getVersion" });
  });

  test("send with an unknown sessionId throws", async () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    await expect(
      manager.send("does-not-exist", { method: "Browser.getVersion" }),
    ).rejects.toThrow("Unknown browser session: does-not-exist");
    // The mock backend should not have received the command.
    expect(state.lastCommand).toBeUndefined();
  });

  test("send with a sessionId of a disposed session throws", async () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockExtensionBackend(state)],
    });
    const session = manager.createSession();
    manager.disposeSession(session.id);
    await expect(
      manager.send(session.id, { method: "Browser.getVersion" }),
    ).rejects.toThrow(`Unknown browser session: ${session.id}`);
    expect(state.lastCommand).toBeUndefined();
  });

  test("selectBackend returns a local backend when it is the only registration", () => {
    const state: MockBackendState = { available: true, disposed: false };
    const backend = createMockLocalBackend(state);
    const manager = new BrowserSessionManager({ backends: [backend] });
    const selected = manager.selectBackend();
    expect(selected.kind).toBe("local");
    expect(selected).toBe(backend);
  });

  test("createSession tags sessions with the local backend kind", () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockLocalBackend(state)],
    });
    const session = manager.createSession();
    expect(session.backendKind).toBe("local");
  });

  test("send routes through local backend when its session is used", async () => {
    const state: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [createMockLocalBackend(state)],
    });
    const session = manager.createSession();
    const result = await manager.send(session.id, {
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    });
    expect(result).toEqual({ result: { ok: true, kind: "local" } });
    expect(state.lastCommand).toEqual({
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    });
  });

  test("selectBackend falls back to the first available backend when earlier ones are unavailable", () => {
    const extState: MockBackendState = { available: false, disposed: false };
    const localState: MockBackendState = { available: true, disposed: false };
    const ext = createMockExtensionBackend(extState);
    const local = createMockLocalBackend(localState);
    const manager = new BrowserSessionManager({ backends: [ext, local] });
    const selected = manager.selectBackend();
    expect(selected.kind).toBe("local");
    expect(selected).toBe(local);
  });

  test("selectBackend prefers the first available backend", () => {
    const extState: MockBackendState = { available: true, disposed: false };
    const localState: MockBackendState = { available: true, disposed: false };
    const ext = createMockExtensionBackend(extState);
    const local = createMockLocalBackend(localState);
    const manager = new BrowserSessionManager({ backends: [ext, local] });
    const selected = manager.selectBackend();
    expect(selected.kind).toBe("extension");
    expect(selected).toBe(ext);
  });

  test("send routes to the backend matching the session's backendKind when multiple backends are registered", async () => {
    const extState: MockBackendState = {
      available: true,
      disposed: false,
      sendImpl: async () => ({ result: { from: "extension" } }),
    };
    const localState: MockBackendState = {
      available: true,
      disposed: false,
      sendImpl: async () => ({ result: { from: "local" } }),
    };
    const ext = createMockExtensionBackend(extState);
    const local = createMockLocalBackend(localState);
    const manager = new BrowserSessionManager({ backends: [ext, local] });

    // createSession picks the first available backend (extension), but we
    // can also force the local one by passing a backendKind via direct
    // session construction. To keep this test self-contained we verify the
    // default path and then mark the extension unavailable to force the
    // local backend for a new session.
    const extSession = manager.createSession();
    expect(extSession.backendKind).toBe("extension");
    const extResult = await manager.send(extSession.id, {
      method: "Browser.getVersion",
    });
    expect(extResult).toEqual({ result: { from: "extension" } });
    expect(extState.lastCommand).toEqual({ method: "Browser.getVersion" });
    expect(localState.lastCommand).toBeUndefined();

    extState.available = false;
    const localSession = manager.createSession();
    expect(localSession.backendKind).toBe("local");
    const localResult = await manager.send(localSession.id, {
      method: "Runtime.evaluate",
    });
    expect(localResult).toEqual({ result: { from: "local" } });
    expect(localState.lastCommand).toEqual({ method: "Runtime.evaluate" });
  });

  test("disposeAll disposes every registered backend", () => {
    const extState: MockBackendState = { available: true, disposed: false };
    const localState: MockBackendState = { available: true, disposed: false };
    const manager = new BrowserSessionManager({
      backends: [
        createMockExtensionBackend(extState),
        createMockLocalBackend(localState),
      ],
    });
    manager.createSession();
    manager.disposeAll();
    expect(extState.disposed).toBe(true);
    expect(localState.disposed).toBe(true);
  });
});
