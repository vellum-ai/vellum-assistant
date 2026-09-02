/**
 * The desktop attention source publishes two channels off one payload:
 * `app.attention` for whether the user is watching, and the lifecycle edge
 * for whether the window is on screen. The edge is what gives the camera
 * hardware back and drops Live capture consent on a minimize, so its presence
 * is pinned as hard as the focus-only cases that must not publish one.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import * as eventBus from "@/lib/event-bus";
import { publishElectronWindowAttentionSource } from "@/runtime/event-sources/electron-window-attention";
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

describe("publishElectronWindowAttentionSource", () => {
  // The consumers mount before this source starts, so a focused window whose
  // first report only seeded a baseline would leave them holding the
  // unattended default with no edge coming to correct it.
  test("publishes the first payload's attention rather than only seeding a baseline", () => {
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

  // Minimizing is the edge the camera and Live capture consent come off.
  test("publishes app.hidden when the window is minimized", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ visible: true, focused: false, minimized: true });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
      ["app.hidden", { signal: "window_attention" }],
    ]);
  });

  test("publishes app.hidden when the window is no longer visible", () => {
    installBridge();
    start();

    send(ATTENDED);
    publishSpy.mockClear();

    send({ visible: false, focused: false, minimized: false });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
      ["app.hidden", { signal: "window_attention" }],
    ]);
  });

  test("publishes app.resume when the window comes back on screen", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: true });
    publishSpy.mockClear();

    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
      ["app.resume", { signal: "window_attention" }],
    ]);
  });

  // A window sitting visible behind another app is still showing the
  // transcript, so a focus change must not background this renderer.
  test("publishes no lifecycle edge for a focus change that keeps the window on screen", () => {
    installBridge();
    start();

    send(ATTENDED);
    send({ visible: true, focused: false, minimized: false });
    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
      ["app.attention", { attended: false }],
      ["app.attention", { attended: true }],
    ]);
  });

  // The first payload is the current state rather than a transition into it,
  // so nothing is backgrounded or foregrounded by a window merely reporting
  // where it already was.
  test("seeds the on-screen baseline from the first payload without an edge", () => {
    installBridge();
    start();

    send({ visible: false, focused: false, minimized: true });

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: false }],
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

  test("reports a payload the contract cannot read as unattended, with no edge", () => {
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
    __resetLifecycleEdgeForTests();
    start();
    send(ATTENDED);

    expect(publishSpy.mock.calls).toEqual([
      ["app.attention", { attended: true }],
    ]);
  });
});
