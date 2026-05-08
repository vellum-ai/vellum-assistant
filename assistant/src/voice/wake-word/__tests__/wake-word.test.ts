import { afterEach, describe, expect, test } from "bun:test";

import {
  createWakeWordDetector,
  PorcupineWakeWordDetector,
  WakeWordFrameAccumulator,
} from "../index.js";
import { setPorcupineModuleForTesting } from "../porcupine.js";
import type { WakeWordEvent } from "../types.js";

interface FakeEngine {
  process: (pcm: Int16Array) => number;
  release: () => void;
  frameLength: number;
  sampleRate: number;
}

function installFakePorcupine(
  opts: {
    frameLength?: number;
    matchOnNthFrame?: number;
    matchKeywordIndex?: number;
    releaseSpy?: () => void;
  } = {},
): FakeEngine {
  const frameLength = opts.frameLength ?? 4;
  const matchOn = opts.matchOnNthFrame ?? 1;
  const matchKeywordIndex = opts.matchKeywordIndex ?? 0;
  let processedFrames = 0;
  const engine: FakeEngine = {
    frameLength,
    sampleRate: 16_000,
    process: (pcm: Int16Array): number => {
      if (pcm.length !== frameLength) {
        throw new Error(`unexpected frame length ${pcm.length}`);
      }
      processedFrames += 1;
      return processedFrames === matchOn ? matchKeywordIndex : -1;
    },
    release: () => opts.releaseSpy?.(),
  };
  setPorcupineModuleForTesting({
    Porcupine: function MockPorcupine() {
      return engine;
    } as unknown as new (
      accessKey: string,
      keywordPaths: string[],
      sensitivities: number[],
      modelPath?: string,
    ) => FakeEngine,
    BuiltinKeyword: {
      jarvis: "/fake/jarvis.ppn",
      computer: "/fake/computer.ppn",
    },
  });
  return engine;
}

afterEach(() => {
  setPorcupineModuleForTesting(null);
});

describe("createWakeWordDetector", () => {
  test("returns null when access key is missing", () => {
    const detector = createWakeWordDetector({
      provider: "picovoice-porcupine",
      accessKey: null,
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    expect(detector).toBeNull();
  });

  test("returns null when no keywords are configured", () => {
    const detector = createWakeWordDetector({
      provider: "picovoice-porcupine",
      accessKey: "fake-key",
      keywords: [],
    });
    expect(detector).toBeNull();
  });

  test("constructs a Porcupine detector when configured", () => {
    const detector = createWakeWordDetector({
      provider: "picovoice-porcupine",
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    expect(detector).toBeInstanceOf(PorcupineWakeWordDetector);
    expect(detector?.providerId).toBe("picovoice-porcupine");
    expect(detector?.sampleRate).toBe(16_000);
    expect(detector?.keywordLabels).toEqual(["jarvis"]);
  });
});

describe("PorcupineWakeWordDetector", () => {
  test("fires onWake when the engine reports a match", async () => {
    installFakePorcupine({
      frameLength: 4,
      matchOnNthFrame: 2,
      matchKeywordIndex: 0,
    });
    const detector = new PorcupineWakeWordDetector({
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.6,
        },
      ],
    });
    const events: WakeWordEvent[] = [];
    await detector.start((event) => events.push(event));

    detector.processFrame(new Int16Array([1, 2, 3, 4]));
    expect(events).toHaveLength(0);
    detector.processFrame(new Int16Array([5, 6, 7, 8]));
    expect(events).toHaveLength(1);
    expect(events[0]?.keywordIndex).toBe(0);
    expect(events[0]?.keywordLabel).toBe("jarvis");

    await detector.stop();
  });

  test("rejects start() called twice", async () => {
    installFakePorcupine();
    const detector = new PorcupineWakeWordDetector({
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    await detector.start(() => {});
    await expect(detector.start(() => {})).rejects.toThrow(
      /start\(\) called twice/,
    );
    await detector.stop();
  });

  test("processFrame requires the exact frame length", async () => {
    installFakePorcupine({ frameLength: 4 });
    const detector = new PorcupineWakeWordDetector({
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    await detector.start(() => {});
    expect(() => detector.processFrame(new Int16Array([1, 2, 3]))).toThrow(
      /expected 4 samples, received 3/,
    );
    await detector.stop();
  });

  test("processFrame is a no-op after stop()", async () => {
    let released = 0;
    installFakePorcupine({ frameLength: 4, releaseSpy: () => (released += 1) });
    const detector = new PorcupineWakeWordDetector({
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    let calls = 0;
    await detector.start(() => (calls += 1));
    await detector.stop();
    expect(released).toBe(1);
    expect(detector.processFrame(new Int16Array([1, 2, 3, 4]))).toBe(-1);
    expect(calls).toBe(0);
  });

  test("rejects construction when no keywords are supplied", () => {
    expect(
      () =>
        new PorcupineWakeWordDetector({
          accessKey: "fake-key",
          keywords: [],
        }),
    ).toThrow(/at least one keyword/);
  });
});

describe("WakeWordFrameAccumulator", () => {
  test("batches arbitrary-sized chunks into engine-sized frames", async () => {
    installFakePorcupine({
      frameLength: 4,
      matchOnNthFrame: 3,
      matchKeywordIndex: 0,
    });
    const detector = new PorcupineWakeWordDetector({
      accessKey: "fake-key",
      keywords: [
        {
          label: "jarvis",
          source: { kind: "builtin", keyword: "jarvis" },
          sensitivity: 0.5,
        },
      ],
    });
    const events: WakeWordEvent[] = [];
    await detector.start((event) => events.push(event));

    const acc = new WakeWordFrameAccumulator(detector);
    acc.feed(new Int16Array([1, 2, 3])); // partial frame
    expect(events).toHaveLength(0);
    acc.feed(new Int16Array([4, 5, 6, 7, 8])); // completes frame 1, partial frame 2
    expect(events).toHaveLength(0);
    acc.feed(new Int16Array([9, 10, 11, 12])); // completes frame 2 + frame 3 → match
    expect(events).toHaveLength(1);

    acc.reset();
    await detector.stop();
  });
});
