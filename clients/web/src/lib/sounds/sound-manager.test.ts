import { describe, expect, mock, test } from "bun:test";

class FakeAudioContext {
  static lastInstance: FakeAudioContext | null = null;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  resumed = false;
  started = false;
  state: AudioContextState = "suspended";

  constructor() {
    FakeAudioContext.lastInstance = this;
  }

  async resume(): Promise<void> {
    this.resumed = true;
    this.state = "running";
  }

  createOscillator() {
    return {
      connect() {},
      frequency: { setValueAtTime() {} },
      start: () => {
        this.started = true;
      },
      stop() {},
      type: "sine" as OscillatorType,
    };
  }

  createGain() {
    return {
      connect() {},
      gain: {
        exponentialRampToValueAtTime() {},
        linearRampToValueAtTime() {},
        setValueAtTime() {},
      },
    };
  }
}

describe("SoundManager", () => {
  test("plays the default preview without an active sound-effects lifecycle", async () => {
    mock.module("@/lib/sounds/api", () => ({
      fetchSoundFile: async () => null,
    }));
    FakeAudioContext.lastInstance = null;
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });

    const { getSoundManager } = await import("@/lib/sounds/sound-manager");
    const manager = getSoundManager();
    manager.setFeatureEnabled(false);

    await manager.previewFallbackBlip();

    const context = FakeAudioContext.lastInstance as unknown as FakeAudioContext;
    expect(context.resumed).toBe(true);
    expect(context.started).toBe(true);
  });
});
