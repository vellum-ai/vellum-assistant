import { describe, expect, test } from "bun:test";

import type { VoiceProgressConfig } from "../../config/schemas/voice.js";
import {
  FEWER_UPDATES_INTERVAL_MS,
  progressConfigForCadence,
  requestedSessionControl,
  sessionControlTeaching,
} from "../session-controls.js";

const CONFIG: VoiceProgressConfig = {
  enabled: true,
  opsThreshold: 3,
  idleIntervalMs: 5_000,
  maxSilenceMs: 35_000,
  longOpMs: 15_000,
  minGapMs: 6_000,
  generationTimeoutMs: 1_500,
};

describe("progressConfigForCadence", () => {
  test("normal is the configured cadence, untouched", () => {
    expect(progressConfigForCadence(CONFIG, "normal")).toBe(CONFIG);
  });

  test("fewer silences tool activity and stretches the silence tick", () => {
    const fewer = progressConfigForCadence(CONFIG, "fewer");

    expect(fewer.opsThreshold).toBe(Number.MAX_SAFE_INTEGER);
    expect(fewer.longOpMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(fewer.idleIntervalMs).toBe(FEWER_UPDATES_INTERVAL_MS);
    expect(fewer.maxSilenceMs).toBe(FEWER_UPDATES_INTERVAL_MS);
    // Narration stays on: a very long silence still proves the call is alive.
    expect(fewer.enabled).toBe(true);
  });

  test("fewer never speaks more often than the configured heartbeat", () => {
    const fewer = progressConfigForCadence(
      { ...CONFIG, idleIntervalMs: 90_000, maxSilenceMs: 120_000 },
      "fewer",
    );

    expect(fewer.idleIntervalMs).toBe(120_000);
    expect(fewer.maxSilenceMs).toBe(120_000);
  });
});

describe("requestedSessionControl", () => {
  test("the update cadence needs no client declaration", () => {
    expect(requestedSessionControl("Sure. [UPDATES:FEWER]", [])).toEqual({
      action: "updates",
      cadence: "fewer",
    });
  });

  test("a client control needs the client's declaration", () => {
    expect(requestedSessionControl("Bye. [END_CALL]", [])).toBeNull();
    expect(requestedSessionControl("Bye. [END_CALL]", ["end"])).toEqual({
      action: "end",
    });
  });
});

describe("sessionControlTeaching", () => {
  test("teaches the update cadence and only the declared client controls", () => {
    const teaching = sessionControlTeaching(["mute"], {});

    expect(teaching).toContain("[UPDATES:FEWER]");
    expect(teaching).toContain("[MUTE]");
    expect(teaching).not.toContain("[END_CALL]");
    expect(teaching).toContain("Never emit any other bracketed marker.");
  });

  test("a device that can show both asks which one a bare look means", () => {
    const teaching = sessionControlTeaching(["look_screen", "look_camera"], {});

    expect(teaching).toContain("[LOOK:SCREEN]");
    expect(teaching).toContain("[LOOK:CAMERA]");
    expect(teaching).toContain("ask which one instead of guessing");
  });

  test("a device that can look can be told to stop", () => {
    const teaching = sessionControlTeaching(["look_screen", "look_stop"], {});

    expect(teaching).toContain("[LOOK:STOP]");
    expect(
      requestedSessionControl("Stopping. [LOOK:STOP]", ["look_stop"]),
    ).toEqual({ action: "look_stop" });
  });

  test("a device that can show one look needs no question", () => {
    const teaching = sessionControlTeaching(["look_camera"], {});

    expect(teaching).toContain("[LOOK:CAMERA]");
    expect(teaching).not.toContain("[LOOK:SCREEN]");
    expect(teaching).not.toContain("ask which one");
    expect(teaching).not.toContain("cannot turn on a screen share");
  });

  // The silent failure in the report this exists for: asked to look, the
  // assistant neither looked nor said it could not.
  test("a device that can show neither says so rather than pretending", () => {
    expect(sessionControlTeaching(["end"], {})).toContain(
      "This call cannot turn on a screen share or the camera.",
    );
  });

  test("the front-door leg keeps its verdict tokens", () => {
    expect(sessionControlTeaching(["end"], { frontDoor: true })).not.toContain(
      "Never emit any other bracketed marker.",
    );
  });
});
