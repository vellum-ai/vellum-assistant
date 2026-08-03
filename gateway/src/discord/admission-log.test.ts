import { describe, expect, test } from "bun:test";

import {
  AdmissionDropLog,
  type AdmissionDropLogLevel,
} from "./admission-log.js";
import type { AdmissionDropReason } from "./admit.js";
import "../__tests__/test-preload.js";

const CHANNEL = "1532468750740357331";
const OTHER_CHANNEL = "800000000000000002";

/** Reasons that surface once per channel, and the level they surface at. */
const PROMOTED: Array<[AdmissionDropReason, AdmissionDropLogLevel]> = [
  ["channel_not_allowed", "warn"],
  ["not_a_guild_message", "info"],
  ["bot_not_mentioned", "info"],
];

/** Reasons that never surface: machine traffic, unbounded volume, no signal. */
const NEVER_PROMOTED: AdmissionDropReason[] = ["self_authored", "bot_authored"];

describe("AdmissionDropLog", () => {
  test("channel_not_allowed warns, because it is the operator-actionable one", () => {
    // Every gateway stream runs at info, so a drop that only logs at debug is
    // written nowhere and a gate denying every message reads exactly like a
    // gateway receiving none.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
  });

  test("reasons that mean a person was denied are visible", () => {
    for (const [reason, level] of PROMOTED) {
      const dropLog = new AdmissionDropLog();
      expect(dropLog.levelFor(reason, CHANNEL)).toBe(level);
    }
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
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("debug");
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("debug");
  });

  test("a different channel is promoted again", () => {
    // Which room is being denied is half the diagnosis.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
    expect(dropLog.levelFor("channel_not_allowed", OTHER_CHANNEL)).toBe("warn");
  });

  test("a different reason on the same channel is promoted again", () => {
    // A channel that starts denying for a new reason is new information.
    const dropLog = new AdmissionDropLog();
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
    expect(dropLog.levelFor("bot_not_mentioned", CHANNEL)).toBe("info");
  });

  test("promotion stops at the cap and degrades to debug", () => {
    // Bounds memory against a guild with a large channel count. Past the cap
    // the reason falls quiet rather than growing without limit.
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 512; i++) {
      expect(dropLog.levelFor("channel_not_allowed", `channel-${i}`)).toBe(
        "warn",
      );
    }
    expect(dropLog.levelFor("channel_not_allowed", "channel-512")).toBe(
      "debug",
    );
  });

  test("never-promoted reasons consume no budget", () => {
    // Otherwise the bot's own echo across many channels could exhaust a budget
    // and silence the one reason that matters.
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 600; i++) {
      dropLog.levelFor("self_authored", `channel-${i}`);
    }
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
  });

  test("an unbounded reason cannot starve the operator-actionable one", () => {
    // `not_a_guild_message` is keyed on a DM channel, which is unique per
    // sender, so outsiders control its key space. A shared budget would let a
    // stream of DMs exhaust it and permanently demote `channel_not_allowed`.
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 5_000; i++) {
      dropLog.levelFor("not_a_guild_message", `dm-channel-${i}`);
    }
    expect(dropLog.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
  });

  test("exhausting one reason's budget leaves the others intact", () => {
    const dropLog = new AdmissionDropLog();
    for (let i = 0; i < 600; i++) {
      dropLog.levelFor("bot_not_mentioned", `channel-${i}`);
    }
    expect(dropLog.levelFor("bot_not_mentioned", "channel-999")).toBe("debug");
    expect(dropLog.levelFor("channel_not_allowed", "channel-999")).toBe("warn");
    expect(dropLog.levelFor("not_a_guild_message", "channel-999")).toBe("info");
  });

  test("instances do not share state", () => {
    const first = new AdmissionDropLog();
    const second = new AdmissionDropLog();
    expect(first.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
    expect(second.levelFor("channel_not_allowed", CHANNEL)).toBe("warn");
  });
});
