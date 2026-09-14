import { describe, expect, test } from "bun:test";

import { VoiceProgressConfigSchema } from "../../config/schemas/voice.js";
import type { VoiceProgressNarrator } from "../progress-narration.js";
import {
  PROGRESS_FALLBACK_PHRASES,
  PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
} from "../progress-phrases.js";
import {
  createProgressCadence,
  type ProgressCadence,
  type ProgressCadenceHost,
} from "../voice-progress-cadence.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error("waitFor timed out");
}

interface Harness {
  cadence: ProgressCadence;
  spoken: Array<{ phrase: string; language: string | undefined }>;
  host: {
    live: boolean;
    audioIdle: boolean;
    tailUntilMs: number;
    language: string | undefined;
    deltaEpoch: number;
    narrationsSpoken: number;
  };
}

function harness(opts: {
  config?: Partial<ReturnType<typeof VoiceProgressConfigSchema.parse>>;
  narrator?: VoiceProgressNarrator | null;
  language?: string;
}): Harness {
  const state = {
    live: true,
    audioIdle: true,
    tailUntilMs: 0,
    language: opts.language,
    deltaEpoch: 0,
    narrationsSpoken: 0,
  };
  const spoken: Harness["spoken"] = [];
  const host: ProgressCadenceHost = {
    turnId: "turn-1",
    launchedAtMs: Date.now(),
    signal: new AbortController().signal,
    canNarrate: () => state.live,
    isAudioIdle: () => state.audioIdle,
    playbackTailUntilMs: () => state.tailUntilMs,
    transcriptSoFar: () => "what is on my calendar",
    language: () => state.language,
    deltaEpoch: () => state.deltaEpoch,
    speak: (phrase, language) => {
      spoken.push({ phrase, language });
      return true;
    },
    onNarrationSpoken: () => {
      state.narrationsSpoken += 1;
    },
  };
  let counter = 0;
  const cadence = createProgressCadence({
    config: VoiceProgressConfigSchema.parse({
      opsThreshold: 3,
      idleIntervalMs: 60_000,
      maxSilenceMs: 60_000,
      longOpMs: 15_000,
      minGapMs: 10,
      generationTimeoutMs: 1_500,
      ...opts.config,
    }),
    narrator:
      opts.narrator === undefined
        ? { generateProgressText: async () => "Checking your calendar now." }
        : opts.narrator,
    host,
    nextFallbackPhraseIndex: () => counter++,
  });
  return { cadence, spoken, host: state };
}

describe("createProgressCadence", () => {
  test("the ops trigger narrates once the threshold of started tools is reached", async () => {
    const h = harness({});
    h.cadence.toolStarted("web_search", "t1");
    h.cadence.toolStarted("web_fetch", "t2");
    await sleep(15);
    expect(h.spoken).toEqual([]);

    h.cadence.toolStarted("file_read", "t3");
    await waitFor(() => h.spoken.length === 1);

    expect(h.spoken[0]).toEqual({
      phrase: "Checking your calendar now.",
      language: undefined,
    });
    expect(h.cadence.updatesSpoken).toBe(1);
    expect(h.host.narrationsSpoken).toBe(1);
    h.cadence.clear();
  });

  test("a long operation completing narrates on its own beat", async () => {
    const h = harness({ config: { longOpMs: 20 } });
    h.cadence.toolStarted("web_search", "t1");
    await sleep(30);
    h.cadence.toolFinished({
      toolName: "web_search",
      toolUseId: "t1",
      resultPreview: "three results",
    });
    await waitFor(() => h.spoken.length === 1);

    expect(h.cadence.ops[0].completedAtMs).toBeDefined();
    expect(h.cadence.ops[0].resultPreview).toBe("three results");
    h.cadence.clear();
  });

  test("a quick operation completing is only news, not a narration", async () => {
    const h = harness({});
    h.cadence.toolStarted("web_search", "t1");
    h.cadence.toolFinished({ toolName: "web_search", toolUseId: "t1" });
    await sleep(20);

    expect(h.spoken).toEqual([]);
    h.cadence.clear();
  });

  test("a tool_result with no id matches the newest incomplete op of that name", () => {
    const h = harness({});
    h.cadence.toolStarted("web_search", "t1");
    h.cadence.toolStarted("web_search", "t2");
    h.cadence.toolFinished({ toolName: "web_search", isError: true });

    expect(h.cadence.ops[1].completedAtMs).toBeDefined();
    expect(h.cadence.ops[1].isError).toBe(true);
    expect(h.cadence.ops[0].completedAtMs).toBeUndefined();
    h.cadence.clear();
  });

  test("the idle tick narrates news since the last update, and the static fallback covers a null generation", async () => {
    const h = harness({
      config: { idleIntervalMs: 30, maxSilenceMs: 60_000 },
      narrator: { generateProgressText: async () => null },
      language: "es",
    });
    h.cadence.arm();
    await sleep(60);
    // Nothing observable happened: the tick stays quiet.
    expect(h.spoken).toEqual([]);

    h.cadence.toolStarted("web_search", "t1");
    await waitFor(() => h.spoken.length === 1);

    expect(
      PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE.es.map((p) => p.trim()),
    ).toContain(h.spoken[0].phrase.trim());
    // The Spanish table has an entry: the phrase rides the turn's language.
    expect(h.spoken[0].language).toBeUndefined();
    h.cadence.clear();
  });

  test("a static fallback the table lacks in the turn's language is pinned to English", async () => {
    const h = harness({
      config: { idleIntervalMs: 30 },
      narrator: { generateProgressText: async () => null },
      language: "ko",
    });
    h.cadence.arm();
    h.cadence.toolStarted("web_search", "t1");
    await waitFor(() => h.spoken.length === 1);

    expect(PROGRESS_FALLBACK_PHRASES).toContain(h.spoken[0].phrase);
    expect(h.spoken[0].language).toBe("en");
    h.cadence.clear();
  });

  test("the heartbeat speaks after maxSilenceMs even with nothing new", async () => {
    const h = harness({
      config: { idleIntervalMs: 30, maxSilenceMs: 30 },
    });
    h.cadence.arm();
    await waitFor(() => h.spoken.length === 1);
    h.cadence.clear();
  });

  test("nothing speaks while audio is still playing; the countdown restarts once it drains", async () => {
    const h = harness({ config: { idleIntervalMs: 30, maxSilenceMs: 30 } });
    h.host.audioIdle = false;
    h.cadence.arm();
    await sleep(80);
    expect(h.spoken).toEqual([]);

    h.host.audioIdle = true;
    h.cadence.noteAudioSettled();
    await waitFor(() => h.spoken.length === 1);
    h.cadence.clear();
  });

  test("a narration generated while the model resumed speaking is dropped", async () => {
    let release: () => void = () => {};
    const h = harness({
      config: { opsThreshold: 1 },
      narrator: {
        generateProgressText: () =>
          new Promise<string | null>((resolve) => {
            release = () => resolve("Still on it.");
          }),
      },
    });
    h.cadence.toolStarted("web_search", "t1");
    await sleep(10);
    h.host.deltaEpoch += 1;
    release();
    await sleep(20);

    expect(h.spoken).toEqual([]);
    h.cadence.clear();
  });

  test("minGapMs spaces narration from another floor holder", async () => {
    const h = harness({ config: { opsThreshold: 1, minGapMs: 200 } });
    h.cadence.noteFloorHolder();
    h.cadence.toolStarted("web_search", "t1");
    await sleep(30);

    expect(h.spoken).toEqual([]);
    h.cadence.clear();
  });

  test("a null narrator or a disabled config never speaks or arms", async () => {
    const off = harness({ narrator: null, config: { idleIntervalMs: 20 } });
    off.cadence.arm();
    off.cadence.toolStarted("a", "1");
    off.cadence.toolStarted("b", "2");
    off.cadence.toolStarted("c", "3");
    const disabled = harness({
      config: { enabled: false, idleIntervalMs: 20 },
    });
    disabled.cadence.arm();
    disabled.cadence.toolStarted("a", "1");
    disabled.cadence.toolStarted("b", "2");
    disabled.cadence.toolStarted("c", "3");
    await sleep(60);

    expect(off.spoken).toEqual([]);
    expect(disabled.spoken).toEqual([]);
  });

  test("clear stops the dead-air timer and a dead turn is never narrated", async () => {
    const h = harness({ config: { idleIntervalMs: 20, maxSilenceMs: 20 } });
    h.cadence.arm();
    h.cadence.clear();
    await sleep(60);
    expect(h.spoken).toEqual([]);

    h.host.live = false;
    h.cadence.toolStarted("a", "1");
    h.cadence.toolStarted("b", "2");
    h.cadence.toolStarted("c", "3");
    await sleep(20);
    expect(h.spoken).toEqual([]);
  });
});
