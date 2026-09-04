/**
 * `runtime/window-attention.ts` owns the desktop host's window-attention
 * bridge and the synchronous reads of it. `isVisibleToUser` is the
 * cross-platform predicate every "is the user watching this client" consumer
 * asks, so the browser and iOS branch is covered here as well as Electron's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import {
  isVisibleToUser,
  isWindowAttended,
  subscribeToWindowAttention,
} from "@/runtime/window-attention";

const ATTENDED: WindowAttentionPayload = {
  visible: true,
  focused: true,
  minimized: false,
};

let listener: ((payload: WindowAttentionPayload) => void) | null = null;
let unsubscribe: (() => void) | null = null;

const realVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

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

/** Push a payload the way main broadcasts one, shape unchecked. */
function send(payload: unknown): void {
  listener?.(payload as WindowAttentionPayload);
}

beforeEach(() => {
  listener = null;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  delete window.vellum;
  if (realVisibilityState) {
    Object.defineProperty(document, "visibilityState", realVisibilityState);
  }
});

describe("isWindowAttended", () => {
  test("is true off Electron, where the DOM is the authority", () => {
    unsubscribe = subscribeToWindowAttention(() => undefined);

    expect(isWindowAttended()).toBe(true);
  });

  test("is false under an Electron host that never reports", () => {
    installBridgeWithoutAttention();
    unsubscribe = subscribeToWindowAttention(() => undefined);

    expect(isWindowAttended()).toBe(false);
  });

  test("tracks the reported window state", () => {
    installBridge();
    unsubscribe = subscribeToWindowAttention(() => undefined);

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
    unsubscribe = subscribeToWindowAttention(() => undefined);

    send(ATTENDED);
    send({ visible: "yes" });

    expect(isWindowAttended()).toBe(false);
  });

  test("returns to the no-payload default on teardown", () => {
    installBridge();
    unsubscribe = subscribeToWindowAttention(() => undefined);
    send({ visible: false, focused: false, minimized: true });

    unsubscribe();
    unsubscribe = null;
    delete window.vellum;

    expect(isWindowAttended()).toBe(true);
  });

  test("delivers a payload the contract cannot read as null", () => {
    installBridge();
    const seen: Array<WindowAttentionPayload | null> = [];
    unsubscribe = subscribeToWindowAttention((payload) => {
      seen.push(payload);
    });

    send(ATTENDED);
    send({ minimized: null });

    expect(seen).toEqual([ATTENDED, null]);
  });
});

describe("isVisibleToUser", () => {
  test("reads the DOM in a browser tab", () => {
    setVisibilityState("visible");
    expect(isVisibleToUser()).toBe(true);

    setVisibilityState("hidden");
    expect(isVisibleToUser()).toBe(false);
  });

  // The regression this predicate exists for: `isWindowAttended()` answers
  // `true` off Electron whatever the DOM says, so a consumer reading it
  // directly suppresses notifications for a backgrounded tab.
  test("reports a hidden tab as not visible where window attention does not", () => {
    setVisibilityState("hidden");

    expect(isWindowAttended()).toBe(true);
    expect(isVisibleToUser()).toBe(false);
  });

  test("reads the host's window report under Electron, not the DOM", () => {
    // Vellum windows disable the Page Visibility API, so the DOM reads
    // visible wherever the window actually is.
    setVisibilityState("visible");
    installBridge();
    unsubscribe = subscribeToWindowAttention(() => undefined);

    send(ATTENDED);
    expect(isVisibleToUser()).toBe(true);

    send({ visible: true, focused: true, minimized: true });
    expect(isVisibleToUser()).toBe(false);
  });
});
