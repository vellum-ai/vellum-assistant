/**
 * Tests for `attachDeviceWriter` — the glue that forwards an
 * `AvatarRenderer`'s Y4M frames into an open v4l2 device sink.
 *
 * Coverage:
 *   - Frames delivered to the renderer's `onFrame` channel are
 *     forwarded to the sink when the FPS cap permits.
 *   - Frames arriving inside the min-interval window are dropped
 *     (`droppedCount` increments, `dispatchedCount` does not).
 *   - `stop()` detaches the subscription — a frame emitted after
 *     stop does not reach the sink.
 *   - `stop()` is idempotent: repeat calls settle without throwing,
 *     and the renderer's subscriber count is 0 after the first call.
 *   - Sink write failures are counted as drops rather than bubbling
 *     up (so the bot doesn't crash if the kernel buffer momentarily
 *     back-pressures).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetAvatarRegistryForTests,
  attachDeviceWriter,
  DEFAULT_MAX_FPS,
  type Y4MFrame,
} from "../src/media/avatar/index.js";

import { FakeAvatarRenderer } from "./avatar-interface.test.js";

function makeFrame(overrides: Partial<Y4MFrame> = {}): Y4MFrame {
  return {
    bytes: overrides.bytes ?? new Uint8Array([1, 2, 3, 4]),
    timestamp: overrides.timestamp ?? 0,
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
  };
}

interface RecordingSink {
  writes: Uint8Array[];
  write(chunk: Uint8Array): boolean;
}

function makeSink(): RecordingSink {
  const writes: Uint8Array[] = [];
  return {
    writes,
    write(chunk: Uint8Array): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

describe("attachDeviceWriter", () => {
  beforeEach(() => {
    __resetAvatarRegistryForTests();
  });

  test("forwards frames from renderer.onFrame to sink.write", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();

    // Synthetic clock so we fully control the FPS gate.
    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink,
      maxFps: 30,
      now: () => now,
    });

    const frameA = makeFrame({ timestamp: 1 });
    renderer.emitFrame(frameA);
    // Next allowed dispatch is now + 33ms (floor(1000/30))
    now = 100;
    const frameB = makeFrame({ timestamp: 2 });
    renderer.emitFrame(frameB);

    expect(sink.writes).toHaveLength(2);
    expect(sink.writes[0]).toBe(frameA.bytes);
    expect(sink.writes[1]).toBe(frameB.bytes);
    expect(handle.dispatchedCount()).toBe(2);
    expect(handle.droppedCount()).toBe(0);

    handle.stop();
  });

  test("drops frames that arrive inside the FPS cap interval", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();

    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink,
      maxFps: 30,
      now: () => now,
    });

    // Frame 1 at t=0 → dispatched (first frame always clears).
    renderer.emitFrame(makeFrame({ timestamp: 1 }));
    // Frame 2 at t=10ms (< 33ms interval for 30 FPS) → dropped.
    now = 10;
    renderer.emitFrame(makeFrame({ timestamp: 2 }));
    // Frame 3 at t=20ms (< 33ms) → dropped.
    now = 20;
    renderer.emitFrame(makeFrame({ timestamp: 3 }));
    // Frame 4 at t=34ms (≥ 33ms) → dispatched.
    now = 34;
    renderer.emitFrame(makeFrame({ timestamp: 4 }));

    expect(sink.writes).toHaveLength(2);
    expect(handle.dispatchedCount()).toBe(2);
    expect(handle.droppedCount()).toBe(2);

    handle.stop();
  });

  test("uses the default FPS cap when unspecified", () => {
    // Sanity: confirm DEFAULT_MAX_FPS is applied. The floor of 1000/30
    // is 33ms, so two frames at t=0 and t=20 should collapse to 1.
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();
    let now = 0;

    expect(DEFAULT_MAX_FPS).toBe(30);
    const handle = attachDeviceWriter({
      renderer,
      sink,
      now: () => now,
    });
    renderer.emitFrame(makeFrame());
    now = 20;
    renderer.emitFrame(makeFrame());
    expect(handle.dispatchedCount()).toBe(1);
    expect(handle.droppedCount()).toBe(1);
    handle.stop();
  });

  test("maxFps=Infinity disables the cap (every frame dispatched)", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();
    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink,
      maxFps: Infinity,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      renderer.emitFrame(makeFrame({ timestamp: i }));
      // Advance clock by 1ms per frame — far inside any sane FPS cap.
      now += 1;
    }
    expect(handle.dispatchedCount()).toBe(10);
    expect(handle.droppedCount()).toBe(0);
    handle.stop();
  });

  test("stop() detaches the subscription — late frames do not reach sink", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();
    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink,
      now: () => now,
    });

    renderer.emitFrame(makeFrame());
    expect(sink.writes).toHaveLength(1);
    // Renderer has one subscriber attached.
    expect(renderer.subscriberCount()).toBe(1);

    handle.stop();
    // Subscriber list cleared after stop.
    expect(renderer.subscriberCount()).toBe(0);

    now = 500;
    renderer.emitFrame(makeFrame());
    // No additional writes despite the frame being emitted.
    expect(sink.writes).toHaveLength(1);
  });

  test("stop() is idempotent — repeat calls settle without throwing", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();
    const handle = attachDeviceWriter({
      renderer,
      sink,
      now: () => 0,
    });
    handle.stop();
    handle.stop();
    handle.stop();
    // No subscriber leaks.
    expect(renderer.subscriberCount()).toBe(0);
  });

  test("sink.write throwing counts as a drop (no crash)", () => {
    const renderer = new FakeAvatarRenderer();
    const angrySink = {
      write(): boolean {
        throw new Error("kernel buffer full");
      },
    };
    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink: angrySink,
      maxFps: 30,
      now: () => now,
    });

    // Should not throw.
    renderer.emitFrame(makeFrame());
    expect(handle.dispatchedCount()).toBe(0);
    expect(handle.droppedCount()).toBe(1);

    handle.stop();
  });

  test("onFrameProcessed observer fires for every frame with dispatch decision", () => {
    const renderer = new FakeAvatarRenderer();
    const sink = makeSink();
    const observed: Array<{ timestamp: number; dispatched: boolean }> = [];
    let now = 0;
    const handle = attachDeviceWriter({
      renderer,
      sink,
      maxFps: 30,
      now: () => now,
      onFrameProcessed: (frame, dispatched) => {
        observed.push({ timestamp: frame.timestamp, dispatched });
      },
    });

    renderer.emitFrame(makeFrame({ timestamp: 1 }));
    now = 5;
    renderer.emitFrame(makeFrame({ timestamp: 2 }));
    now = 50;
    renderer.emitFrame(makeFrame({ timestamp: 3 }));

    expect(observed).toEqual([
      { timestamp: 1, dispatched: true },
      { timestamp: 2, dispatched: false },
      { timestamp: 3, dispatched: true },
    ]);

    handle.stop();
  });
});
