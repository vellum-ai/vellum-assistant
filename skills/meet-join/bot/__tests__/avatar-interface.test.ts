/**
 * Shape tests for the `AvatarRenderer` interface, built around a tiny
 * in-memory fake renderer that advertises both capabilities and records
 * frame callbacks. The fake is `export`ed so later renderer PRs can use
 * it as a shared fixture for wiring-level tests (factory resolution,
 * capability-driven routing, lifecycle coordination) without pulling in
 * a real backend.
 *
 * Coverage:
 * - Interface: `AvatarRenderer`'s lifecycle contract — `start()` + `stop()`
 *   both resolve, `stop()` is idempotent.
 * - Interface: `pushAudio` / `pushViseme` are always callable regardless of
 *   capability values.
 * - Interface: `onFrame` dispatches frames to subscribers and returns a
 *   working unsubscribe function.
 * - Error: `AvatarRendererUnavailableError` preserves `rendererId` /
 *   `reason` and is `instanceof Error`.
 */
import { describe, expect, test } from "bun:test";

import {
  AvatarRendererUnavailableError,
  type AvatarCapabilities,
  type AvatarRenderer,
  type VisemeEvent,
  type Y4MFrame,
} from "../src/media/avatar/index.js";

/**
 * Minimal in-memory `AvatarRenderer` implementation. Records everything
 * the daemon pushes at it and exposes an `emitFrame` helper so tests can
 * drive the frame-dispatch side of the contract deterministically.
 *
 * Defaults to `{ needsVisemes: true, needsAudio: true }` so the fake
 * opts into both input streams, but callers can override either flag to
 * test capability-driven routing.
 */
export interface FakeAvatarRendererOptions {
  id?: string;
  capabilities?: Partial<AvatarCapabilities>;
}

export class FakeAvatarRenderer implements AvatarRenderer {
  readonly id: string;
  readonly capabilities: AvatarCapabilities;

  /** Audio chunks pushed by the daemon, in arrival order. */
  readonly audioChunks: Array<{ pcm: Uint8Array; ts: number }> = [];
  /** Viseme events pushed by the daemon, in arrival order. */
  readonly visemes: VisemeEvent[] = [];

  /** How many times `start()` has been invoked. */
  startCount = 0;
  /** How many times `stop()` has been invoked. */
  stopCount = 0;

  private subscribers: Array<(frame: Y4MFrame) => void> = [];

  constructor(opts: FakeAvatarRendererOptions = {}) {
    this.id = opts.id ?? "fake";
    this.capabilities = {
      needsVisemes: opts.capabilities?.needsVisemes ?? true,
      needsAudio: opts.capabilities?.needsAudio ?? true,
    };
  }

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    // Clear subscribers on stop so the test can assert no stray dispatches
    // leak past the end of a renderer's lifecycle.
    this.subscribers = [];
  }

  pushAudio(pcm: Uint8Array, ts: number): void {
    if (!this.capabilities.needsAudio) return;
    // Copy so downstream mutations to the caller's buffer can't alter
    // what we recorded.
    this.audioChunks.push({ pcm: new Uint8Array(pcm), ts });
  }

  pushViseme(event: VisemeEvent): void {
    if (!this.capabilities.needsVisemes) return;
    this.visemes.push({ ...event });
  }

  onFrame(cb: (frame: Y4MFrame) => void): () => void {
    this.subscribers.push(cb);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const idx = this.subscribers.indexOf(cb);
      if (idx !== -1) this.subscribers.splice(idx, 1);
    };
  }

  /** Test helper: dispatch a frame to every current subscriber. */
  emitFrame(frame: Y4MFrame): void {
    // Copy the subscriber list so an unsubscribe mid-dispatch doesn't
    // skip a neighbour.
    for (const cb of this.subscribers.slice()) cb(frame);
  }

  /** Test helper: how many subscribers are currently attached. */
  subscriberCount(): number {
    return this.subscribers.length;
  }
}

/** Build a deterministic Y4M frame for use in tests. */
function makeFrame(overrides: Partial<Y4MFrame> = {}): Y4MFrame {
  return {
    bytes: overrides.bytes ?? new Uint8Array([1, 2, 3, 4]),
    timestamp: overrides.timestamp ?? 0,
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
  };
}

describe("FakeAvatarRenderer (shared test fixture)", () => {
  test("advertises both capabilities by default", () => {
    const r = new FakeAvatarRenderer();
    expect(r.capabilities).toEqual({ needsVisemes: true, needsAudio: true });
    expect(r.id).toBe("fake");
  });

  test("allows capabilities to be overridden", () => {
    const r = new FakeAvatarRenderer({
      id: "noop",
      capabilities: { needsVisemes: false, needsAudio: false },
    });
    expect(r.id).toBe("noop");
    expect(r.capabilities).toEqual({ needsVisemes: false, needsAudio: false });
  });

  test("start() and stop() resolve and record invocation counts", async () => {
    const r = new FakeAvatarRenderer();
    expect(r.startCount).toBe(0);
    await r.start();
    expect(r.startCount).toBe(1);
    await r.stop();
    expect(r.stopCount).toBe(1);
  });

  test("stop() is idempotent — repeat calls settle without throwing", async () => {
    const r = new FakeAvatarRenderer();
    await r.start();
    await r.stop();
    await r.stop();
    await r.stop();
    expect(r.stopCount).toBe(3);
  });

  test("pushAudio / pushViseme record events when capabilities permit", () => {
    const r = new FakeAvatarRenderer();
    const chunk = new Uint8Array([10, 20, 30]);
    r.pushAudio(chunk, 42);
    r.pushViseme({ phoneme: "ah", weight: 0.7, timestamp: 100 });
    expect(r.audioChunks).toHaveLength(1);
    expect(r.audioChunks[0]!.ts).toBe(42);
    expect(Array.from(r.audioChunks[0]!.pcm)).toEqual([10, 20, 30]);
    expect(r.visemes).toHaveLength(1);
    expect(r.visemes[0]).toEqual({
      phoneme: "ah",
      weight: 0.7,
      timestamp: 100,
    });
  });

  test("pushAudio / pushViseme are no-ops when the capability is false — but still callable", () => {
    const r = new FakeAvatarRenderer({
      capabilities: { needsVisemes: false, needsAudio: false },
    });
    // Must not throw — the interface requires these to be always callable.
    r.pushAudio(new Uint8Array([1, 2, 3]), 0);
    r.pushViseme({ phoneme: "ah", weight: 1, timestamp: 0 });
    expect(r.audioChunks).toHaveLength(0);
    expect(r.visemes).toHaveLength(0);
  });

  test("onFrame dispatches frames to subscribers", () => {
    const r = new FakeAvatarRenderer();
    const received: Y4MFrame[] = [];
    r.onFrame((f) => received.push(f));
    const frame = makeFrame({ timestamp: 1000 });
    r.emitFrame(frame);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(frame);
  });

  test("onFrame returns a working unsubscribe function", () => {
    const r = new FakeAvatarRenderer();
    const received: Y4MFrame[] = [];
    const unsubscribe = r.onFrame((f) => received.push(f));

    r.emitFrame(makeFrame({ timestamp: 1 }));
    expect(received).toHaveLength(1);
    expect(r.subscriberCount()).toBe(1);

    unsubscribe();
    expect(r.subscriberCount()).toBe(0);

    r.emitFrame(makeFrame({ timestamp: 2 }));
    // No new frames should have landed after unsubscribe.
    expect(received).toHaveLength(1);
  });

  test("onFrame unsubscribe is idempotent", () => {
    const r = new FakeAvatarRenderer();
    const unsubscribe = r.onFrame(() => {});
    expect(r.subscriberCount()).toBe(1);
    unsubscribe();
    expect(r.subscriberCount()).toBe(0);
    // A second call must be a no-op.
    unsubscribe();
    expect(r.subscriberCount()).toBe(0);
  });

  test("onFrame supports multiple independent subscribers", () => {
    const r = new FakeAvatarRenderer();
    const a: Y4MFrame[] = [];
    const b: Y4MFrame[] = [];
    const unA = r.onFrame((f) => a.push(f));
    r.onFrame((f) => b.push(f));

    r.emitFrame(makeFrame({ timestamp: 1 }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    // Unsubscribing `a` must not disturb `b`.
    unA();
    r.emitFrame(makeFrame({ timestamp: 2 }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});

describe("AvatarRendererUnavailableError", () => {
  test("preserves rendererId and reason, is an Error subclass", () => {
    const err = new AvatarRendererUnavailableError(
      "simli",
      "missing SIMLI_API_KEY",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AvatarRendererUnavailableError);
    expect(err.name).toBe("AvatarRendererUnavailableError");
    expect(err.rendererId).toBe("simli");
    expect(err.reason).toBe("missing SIMLI_API_KEY");
    expect(err.message).toContain("simli");
    expect(err.message).toContain("missing SIMLI_API_KEY");
  });
});
