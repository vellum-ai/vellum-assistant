import { describe, expect, test } from "bun:test";

import { AdmissionDropLog } from "./admission-log.js";
import type { AdmissionDropReason } from "./admit.js";
import "../__tests__/test-preload.js";

const CHANNEL = "1532468750740357331";
const OTHER_CHANNEL = "800000000000000002";

/** Reasons that never surface: machine traffic, unbounded volume, no signal. */
const NEVER_PROMOTED: AdmissionDropReason[] = ["self_authored", "bot_authored"];

describe("AdmissionDropLog", () => {
  test("a person's un-addressed message surfaces once, at info", () => {
    // Every gateway stream runs at info, so a drop that only logs at debug is
    // written nowhere and a gate denying every message reads exactly like a
    // gateway receiving none. One line per channel is the whole diagnosis.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
  });

  test("the bot's own echo and other bots never promote", () => {
    // These scale with how chatty the room is and no operator needs one.
    // Neither can be caused by a misconfiguration, so nothing is lost.
    for (const reason of NEVER_PROMOTED) {
      const dropLog = new AdmissionDropLog();
      expect(dropLog.levelFor(reason, CHANNEL)).toBe("debug");
      expect(dropLog.levelFor(reason, OTHER_CHANNEL)).toBe("debug");
    }
  });

  test("repeats fall back to debug", () => {
    // The gate denies by design, so promoting every drop would flood the
    // stream it exists to keep quiet.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("debug");
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("debug");
  });

  test("a different channel is promoted again", () => {
    // Which room is being denied is half the diagnosis.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
    expect(dropLog.levelFor("bot_not_mentioned", OTHER_CHANNEL)).toBe("info");
  });

  test("promotion stops at the cap and degrades to debug", () => {
    // Bounds memory against a guild with a large channel count. Past the cap
    // the reason falls quiet rather than growing without limit.
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 512; i++) {
      expect(dropLog.levelFor("bot_not_mentioned", `channel-${i}`)).toBe(
        "info",
      );
    }
    expect(dropLog.levelFor("bot_not_mentioned", "channel-512")).toBe("debug");
  });

  test("never-promoted reasons consume no budget", () => {
    // Otherwise the bot's own echo across many channels could exhaust a
    // budget and silence the reason that carries signal.
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 600; i++) {
      dropLog.levelFor("self_authored", `channel-${i}`);
    }
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
  });

  test("instances do not share state", () => {
    const first = new AdmissionDropLog();
    const second = new AdmissionDropLog();
    expect(first.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
    expect(second.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
  });
});
