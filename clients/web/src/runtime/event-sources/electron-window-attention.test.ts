/**
 * The desktop attention source publishes `app.attention` and nothing else.
 * A lifecycle edge from here would background every consumer that reads one,
 * including the SSE teardown that delivers the notifications a minimized
 * desktop app is waiting for, so the absence of `app.hidden` is pinned as
 * hard as the presence of `app.attention`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import * as eventBus from "@/lib/event-bus";
import { publishElectronWindowAttentionSource } from "@/runtime/event-sources/electron-window-attention";

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

function start(): void {
  teardown = publishElectronWindowAttentionSource();
}

/** Push a payload the way main broadcasts one, shape unchecked. */
function send(payload: unknown): void {
  listener?.(payload as WindowAttentionPayload);
}

beforeEach(() => {
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

describe("publishElectronWindowAttentionSource", () => {
  // The consumers mount before this source starts, so a focused window whose
  // first report only seeded a baseline would leave them holding the
  // unattended default with no edge coming to correct it.
  test("publishes the first payload rather than only seeding a baseline", () => {
    installBridge();
    start();

    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
    ]);
  });

  test("publishes app.attention when a window on screen loses focus", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ visible: true, focused: false, minimized: false });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
    ]);
  });

  test("publishes app.attention when a window on screen takes focus back", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: false });
    publishSpy.mockClear();

    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
    ]);
  });

  // Minimizing must not background the renderer. `app.hidden` tears the SSE
  // stream down behind a five second grace, and the desktop has no push
  // fallback, so every notification broadcast while minimized would be lost.
  test("publishes no lifecycle edge when the window is minimized", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ visible: true, focused: false, minimized: true });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
    ]);
  });

  test("publishes no lifecycle edge when the window is no longer visible", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ visible: false, focused: false, minimized: false });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
    ]);
  });

  test("publishes no lifecycle edge when the window comes back on screen", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: true });
    publishSpy.mockClear();

    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
    ]);
  });

  test("repeats no attention edge for a payload that changes nothing", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send(ATTENDED);

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("reports a payload the contract cannot read as unattended", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ minimized: null });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
    ]);
  });

  test("publishes nothing off Electron", () => {
    start();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("unsubscribes on teardown and republishes the next first payload", () => {
    installBridge();
    start();
    send(ATTENDED);

    teardown?.();
    teardown = null;
    expect(unsubscribeCalls).toBe(1);

    publishSpy.mockClear();
    start();
    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
    ]);
  });
});
