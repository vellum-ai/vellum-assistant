import { describe, expect, test } from "bun:test";

import {
  type BrowserBackend,
  BrowserSessionManager,
  type CdpCommand,
  type CdpResult,
  createExtensionBackend,
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
});
