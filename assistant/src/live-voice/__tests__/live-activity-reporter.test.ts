/**
 * Tests for the Live Activity phase reporter.
 *
 * The dispatch itself reaches the platform, so these cover the decisions made
 * before it: which frames move the phase, which repeats are suppressed, and
 * that ending is latched. The suppression is the load-bearing part —
 * `tts_audio` arrives many times a second and ActivityKit silently drops
 * updates past its rate limit, so a reporter that forwarded every frame would
 * spend the whole budget restating `speaking`.
 */

import { describe, expect, test } from "bun:test";

import {
  LiveActivityReporter,
  phaseForFrame,
} from "../live-activity-reporter.js";

/** A reporter whose dispatches are captured instead of sent. */
class RecordingReporter extends LiveActivityReporter {
  readonly dispatched: Array<{ phase: string; event: string }> = [];

  protected override async dispatch(
    phase: string,
    event: "update" | "end",
  ): Promise<void> {
    this.dispatched.push({ phase, event });
  }
}

describe("phaseForFrame", () => {
  test("maps the frames the client derives phases from", () => {
    expect(phaseForFrame("utterance_ended")).toBe("transcribing");
    expect(phaseForFrame("stt_final")).toBe("thinking");
    expect(phaseForFrame("thinking")).toBe("thinking");
    expect(phaseForFrame("tts_audio")).toBe("speaking");
  });

  test("a discarded utterance returns the floor to the user", () => {
    expect(phaseForFrame("utterance_discarded")).toBe("listening");
    expect(phaseForFrame("tts_done")).toBe("listening");
  });

  test("frames that say nothing about the phase move nothing", () => {
    expect(phaseForFrame("stt_partial")).toBeNull();
    expect(phaseForFrame("ready")).toBeNull();
    expect(phaseForFrame("some_frame_added_later")).toBeNull();
  });
});

describe("LiveActivityReporter", () => {
  test("reports a phase change once", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report("thinking");

    expect(reporter.dispatched).toEqual([
      { phase: "thinking", event: "update" },
    ]);
  });

  // The whole reason this class exists rather than a bare fetch per frame.
  test("does not re-report a phase it is already in", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report("tts_audio");
    reporter.report("tts_audio");
    reporter.report("tts_audio");

    expect(reporter.dispatched).toEqual([
      { phase: "speaking", event: "update" },
    ]);
  });

  test("reports each genuine transition through a turn", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report("utterance_ended");
    reporter.report("stt_final");
    reporter.report("tts_audio");
    reporter.report("tts_audio");
    reporter.report("tts_done");

    expect(reporter.dispatched.map((d) => d.phase)).toEqual([
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  test("frames that do not move the phase are ignored", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report("stt_partial");
    reporter.report("ready");

    expect(reporter.dispatched).toEqual([]);
  });

  test("ending retires the activity", () => {
    const reporter = new RecordingReporter("conv-1");
    reporter.report("tts_audio");

    reporter.end();

    expect(reporter.dispatched.at(-1)).toEqual({
      phase: "ending",
      event: "end",
    });
  });

  // A session can end more than one way and the platform deletes the
  // registration on the first, so a second end would push at an activity that
  // is already gone.
  test("ending twice pushes once", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.end();
    reporter.end();

    expect(reporter.dispatched).toHaveLength(1);
  });

  test("a frame after the end is not reported", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.end();
    reporter.report("tts_audio");

    expect(reporter.dispatched).toEqual([{ phase: "ending", event: "end" }]);
  });
});
