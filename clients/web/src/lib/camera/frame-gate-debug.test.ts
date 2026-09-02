/**
 * What the tuning readout collects, what it costs when nobody asked for it,
 * and the rule that keeps a moved threshold out of a real session.
 *
 * The animation frame and the object-URL factory are both stubbed, because the
 * two properties under test are about scheduling and about lifetime: how many
 * times subscribers are woken for a burst of frames, and whether an evicted
 * thumbnail gives its bytes back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_FRAME_GATE_OPTIONS,
  type FrameGateDecision,
} from "./frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  defaultFrameGateOverrides,
  getFrameGateDebugSnapshot,
  isFrameGateDebugEnabled,
  recordFrameGateDecision,
  recordFrameGateKeep,
  subscribeFrameGateDebug,
  syncFrameGateDebugOptions,
  type FrameGateOverrides,
} from "./frame-gate-debug";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let pendingFrames: Array<() => void> = [];
let revokedUrls: string[] = [];
let createdUrls = 0;

function flushFrames(): void {
  const queued = pendingFrames;
  pendingFrames = [];
  for (const frame of queued) {
    frame();
  }
}

function decision(
  overrides: Partial<FrameGateDecision> = {},
): FrameGateDecision {
  return {
    keep: false,
    reason: "unchanged",
    motion: 0.01,
    novelty: 0.2,
    detail: 20,
    ...overrides,
  };
}

function overridesWith(patch: Partial<FrameGateOverrides>): FrameGateOverrides {
  return { ...defaultFrameGateOverrides(), ...patch };
}

function jpeg(): File {
  return new File([new Uint8Array([1, 2, 3])], "frame.jpg", {
    type: "image/jpeg",
  });
}

beforeEach(() => {
  pendingFrames = [];
  revokedUrls = [];
  createdUrls = 0;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    pendingFrames.push(() => callback(0));
    return pendingFrames.length;
  }) as typeof globalThis.requestAnimationFrame;
  URL.createObjectURL = () => {
    createdUrls += 1;
    return `blob:frame-${createdUrls}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
});

afterEach(() => {
  syncFrameGateDebugOptions(false, defaultFrameGateOverrides());
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("frame gate debug, disabled", () => {
  test("records nothing and never wakes a subscriber", () => {
    let woken = 0;
    const unsubscribe = subscribeFrameGateDebug(() => {
      woken += 1;
    });

    for (let i = 0; i < 10; i++) {
      recordFrameGateDecision("composer", decision(), i);
    }
    recordFrameGateKeep("composer", jpeg());
    flushFrames();

    expect(isFrameGateDebugEnabled()).toBe(false);
    expect(getFrameGateDebugSnapshot().surface).toBeNull();
    expect(getFrameGateDebugSnapshot().total).toBe(0);
    expect(createdUrls).toBe(0);
    expect(woken).toBe(0);
    unsubscribe();
  });
});

describe("frame gate debug, enabled", () => {
  beforeEach(() => {
    syncFrameGateDebugOptions(true, defaultFrameGateOverrides());
  });

  test("fills the ring, the counters and the latest slot", () => {
    recordFrameGateDecision("composer", decision({ reason: "warmup" }), 1);
    recordFrameGateDecision("composer", decision({ reason: "moving" }), 2);
    recordFrameGateDecision(
      "composer",
      decision({ keep: true, reason: "novel", novelty: 0.9 }),
      3,
    );
    flushFrames();

    const snapshot = getFrameGateDebugSnapshot();
    expect(snapshot.surface).toBe("composer");
    expect(snapshot.total).toBe(3);
    expect(snapshot.latest?.reason).toBe("novel");
    expect(snapshot.latest?.keep).toBe(true);
    expect(snapshot.latest?.novelty).toBe(0.9);
    expect(snapshot.recent.map((entry) => entry.reason)).toEqual([
      "novel",
      "moving",
      "warmup",
    ]);
    expect(snapshot.reasonCounts.warmup).toBe(1);
    expect(snapshot.reasonCounts.moving).toBe(1);
    expect(snapshot.reasonCounts.novel).toBe(1);
    expect(snapshot.reasonCounts.unchanged).toBe(0);
  });

  test("the ring is capped and holds the newest decisions", () => {
    for (let i = 1; i <= 200; i++) {
      recordFrameGateDecision("composer", decision(), i);
    }
    flushFrames();

    const snapshot = getFrameGateDebugSnapshot();
    expect(snapshot.total).toBe(200);
    expect(snapshot.recent.length).toBeLessThan(200);
    expect(snapshot.recent[0]?.atMs).toBe(200);
    expect(snapshot.recent.at(-1)?.atMs).toBe(200 - snapshot.recent.length + 1);
  });

  test("a burst of frames wakes subscribers once per animation frame", () => {
    let woken = 0;
    const unsubscribe = subscribeFrameGateDebug(() => {
      woken += 1;
    });

    for (let i = 1; i <= 20; i++) {
      recordFrameGateDecision("composer", decision(), i);
    }
    expect(woken).toBe(0);
    flushFrames();
    expect(woken).toBe(1);

    recordFrameGateDecision("composer", decision(), 21);
    flushFrames();
    expect(woken).toBe(2);

    unsubscribe();
  });

  test("the snapshot follows whichever surface fed the gate last", () => {
    recordFrameGateDecision("voice", decision(), 1);
    flushFrames();
    expect(getFrameGateDebugSnapshot().surface).toBe("voice");

    recordFrameGateDecision("composer", decision(), 2);
    flushFrames();
    expect(getFrameGateDebugSnapshot().surface).toBe("composer");

    recordFrameGateDecision("voice", decision(), 3);
    flushFrames();
    expect(getFrameGateDebugSnapshot().surface).toBe("voice");
  });

  test("counters and rings are kept per surface", () => {
    recordFrameGateDecision("voice", decision({ reason: "moving" }), 1);
    recordFrameGateDecision("voice", decision({ reason: "moving" }), 2);
    recordFrameGateDecision("composer", decision({ reason: "warmup" }), 3);
    flushFrames();

    const snapshot = getFrameGateDebugSnapshot();
    expect(snapshot.surface).toBe("composer");
    expect(snapshot.total).toBe(1);
    expect(snapshot.reasonCounts.moving).toBe(0);
    expect(snapshot.reasonCounts.warmup).toBe(1);
  });

  test("the keep strip evicts the oldest frame and revokes its URL", () => {
    for (let i = 0; i < 8; i++) {
      recordFrameGateKeep("composer", jpeg());
    }
    recordFrameGateDecision("composer", decision({ keep: true }), 1);
    flushFrames();

    const snapshot = getFrameGateDebugSnapshot();
    expect(createdUrls).toBe(8);
    expect(snapshot.keeps.length).toBe(6);
    expect(revokedUrls).toEqual(["blob:frame-1", "blob:frame-2"]);
    expect(snapshot.keeps[0]?.url).toBe("blob:frame-8");
  });
});

describe("frame gate live options", () => {
  test("an override reaches the record only while the readout is on", () => {
    syncFrameGateDebugOptions(false, overridesWith({ noveltyThreshold: 1.2 }));
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold,
    );

    syncFrameGateDebugOptions(true, overridesWith({ noveltyThreshold: 1.2 }));
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(1.2);
  });

  test("turning the readout off puts every shipped default back", () => {
    syncFrameGateDebugOptions(
      true,
      overridesWith({
        noveltyThreshold: 1.5,
        settleThreshold: 0.3,
        minDetail: 40,
        minIntervalMs: 500,
        maxIntervalMs: 90_000,
      }),
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(500);

    syncFrameGateDebugOptions(
      false,
      overridesWith({ noveltyThreshold: 1.5, minIntervalMs: 500 }),
    );
    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
  });

  test("the record is mutated in place, never replaced", () => {
    const before = FRAME_GATE_LIVE_OPTIONS;
    syncFrameGateDebugOptions(true, overridesWith({ minDetail: 25 }));
    expect(FRAME_GATE_LIVE_OPTIONS).toBe(before);
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(25);
  });

  test("out-of-range and unusable values fall back to the default", () => {
    syncFrameGateDebugOptions(
      true,
      overridesWith({
        noveltyThreshold: Number.NaN,
        minDetail: 5_000,
        minIntervalMs: -10,
      }),
    );
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(
      DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(60);
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(0);
  });

  test("a crossed interval pair reaches the gate ordered", () => {
    // The gate reads the floor before the heartbeat, so a floor above the
    // ceiling would leave the ceiling unreachable whatever the readout draws.
    syncFrameGateDebugOptions(
      true,
      overridesWith({ minIntervalMs: 20_000, maxIntervalMs: 4_000 }),
    );

    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBeLessThanOrEqual(
      FRAME_GATE_LIVE_OPTIONS.maxIntervalMs,
    );
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(20_000);
    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(20_000);
  });

  test("an ordered interval pair reaches the gate untouched", () => {
    syncFrameGateDebugOptions(
      true,
      overridesWith({ minIntervalMs: 2_000, maxIntervalMs: 45_000 }),
    );

    expect(FRAME_GATE_LIVE_OPTIONS.minIntervalMs).toBe(2_000);
    expect(FRAME_GATE_LIVE_OPTIONS.maxIntervalMs).toBe(45_000);
  });

  test("turning the readout off gives every held thumbnail back", () => {
    syncFrameGateDebugOptions(true, defaultFrameGateOverrides());
    recordFrameGateKeep("composer", jpeg());
    recordFrameGateKeep("voice", jpeg());
    recordFrameGateDecision("composer", decision(), 1);
    flushFrames();

    syncFrameGateDebugOptions(false, defaultFrameGateOverrides());

    expect(revokedUrls.length).toBe(2);
    expect(getFrameGateDebugSnapshot().surface).toBeNull();
    expect(getFrameGateDebugSnapshot().keeps).toEqual([]);
  });
});
