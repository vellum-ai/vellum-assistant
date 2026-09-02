import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import * as eventBus from "@/lib/event-bus";
import {
  isWindowAttended,
  publishElectronWindowAttentionSource,
} from "@/runtime/event-sources/electron-window-attention";
import { __resetLifecycleEdgeForTests } from "@/runtime/event-sources/lifecycle-edge";

const publishSpy = spyOn(eventBus, "publish");

const ATTENDED: WindowAttentionPayload = {
  visible: true,
  focused: true,
  minimized: false,
};

let listener: ((payload: WindowAttentionPayload) => void) | null = null;
let unsubscribeCalls = 0;
let teardown: (() => void) | null = null;

/** Stand in for the preload bridge's window-attention subscriber. */
function installBridge(): void {
  window.vellum = {
    platform: "electron",
    notifications: {
      onWindowAttention: (
        callback: (payload: WindowAttentionPayload) => void,
      ) => {
        listener = callback;
        return () => {
          unsubscribeCalls += 1;
          listener = null;
        };
      },
    },
  } as unknown as Window["vellum"];
}

/** An Electron host whose preload predates the attention channel. */
function installBridgeWithoutAttention(): void {
  window.vellum = { platform: "electron" } as unknown as Window["vellum"];
}

function start(): void {
  teardown = publishElectronWindowAttentionSource();
}

/** Push a payload the way main broadcasts one, shape unchecked. */
function send(payload: unknown): void {
  listener?.(payload as WindowAttentionPayload);
}

beforeEach(() => {
  // The edge window is module state shared with every other source that
  // publishes through it, so a case in another suite can otherwise swallow
  // this one's first edge.
  __resetLifecycleEdgeForTests();
  listener = null;
  unsubscribeCalls = 0;
  publishSpy.mockClear();
});

afterEach(() => {
  teardown?.();
  teardown = null;
  delete window.vellum;
  publishSpy.mockClear();
});

describe("isWindowAttended", () => {
  test("is true off Electron, where the DOM is the authority", () => {
    start();

    expect(isWindowAttended()).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("is false under an Electron host that never reports", () => {
    installBridgeWithoutAttention();
    start();

    expect(isWindowAttended()).toBe(false);
  });

  test("tracks the reported window state", () => {
    installBridge();
    start();

    send(ATTENDED);
    expect(isWindowAttended()).toBe(true);

    send({ visible: true, focused: false, minimized: false });
    expect(isWindowAttended()).toBe(false);

    send({ visible: true, focused: true, minimized: true });
    expect(isWindowAttended()).toBe(false);

    send({ visible: false, focused: false, minimized: false });
    expect(isWindowAttended()).toBe(false);

    send(ATTENDED);
    expect(isWindowAttended()).toBe(true);
  });

  test("is false for a payload the contract cannot read", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: "yes" });

    expect(isWindowAttended()).toBe(false);
  });
});

describe("publishElectronWindowAttentionSource", () => {
  test("seeds the baseline from the first payload without publishing", () => {
    installBridge();
    start();

    send(ATTENDED);

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("publishes app.hidden when the window is minimized", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: true });

    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "window_attention",
    });
  });

  test("publishes app.hidden when the window is no longer visible", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: false, focused: false, minimized: false });

    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "window_attention",
    });
  });

  test("publishes app.resume when the window comes back on screen", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: true });
    publishSpy.mockClear();

    send(ATTENDED);

    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "window_attention",
    });
  });

  test("publishes no edge for a focus change that keeps the window on screen", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: false });
    send(ATTENDED);

    expect(isWindowAttended()).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("publishes no edge for a payload the contract cannot read", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ minimized: null });

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("unsubscribes on teardown and returns to the no-payload default", () => {
    installBridge();
    start();
    send({ visible: false, focused: false, minimized: true });

    teardown?.();
    teardown = null;

    expect(unsubscribeCalls).toBe(1);
    delete window.vellum;
    expect(isWindowAttended()).toBe(true);
  });
});
