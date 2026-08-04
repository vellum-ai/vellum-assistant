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
import type { LiveVoiceServerFramePayload } from "../protocol.js";

/**
 * A server frame of `type`, with whatever else that variant requires.
 *
 * Cast rather than fully constructed: these tests care only about the
 * discriminant, and the protocol's frames carry fields (turn ids, audio
 * payloads) that say nothing about the phase.
 */
function frame(type: string): LiveVoiceServerFramePayload {
  return { type } as LiveVoiceServerFramePayload;
}

function sttFinal(text: string): LiveVoiceServerFramePayload {
  return { type: "stt_final", text } as LiveVoiceServerFramePayload;
}

/** A reporter whose dispatches are captured instead of sent. */
class RecordingReporter extends LiveActivityReporter {
  readonly dispatched: Array<{ phase: string; event: string; detail: string }> =
    [];

  protected override async dispatch(
    phase: string,
    event: "update" | "end",
    detail: string,
  ): Promise<void> {
    this.dispatched.push({ phase, event, detail });
  }
}

function activity(label: string): LiveVoiceServerFramePayload {
  return {
    type: "activity",
    turnId: "t1",
    label,
  } as LiveVoiceServerFramePayload;
}

describe("phaseForFrame", () => {
  test("maps the frames the client derives phases from", () => {
    expect(phaseForFrame(frame("utterance_end"), "listening")).toBe(
      "transcribing",
    );
    expect(phaseForFrame(frame("thinking"), "transcribing")).toBe("thinking");
    expect(phaseForFrame(frame("tts_audio"), "thinking")).toBe("speaking");
  });

  test("a discarded utterance returns the floor to the user", () => {
    expect(phaseForFrame(frame("utterance_discarded"), "transcribing")).toBe(
      "listening",
    );
    expect(phaseForFrame(frame("tts_done"), "speaking")).toBe("listening");
  });

  test("frames that say nothing about the phase move nothing", () => {
    expect(phaseForFrame(frame("stt_partial"), "listening")).toBeNull();
    expect(phaseForFrame(frame("ready"), "listening")).toBeNull();
  });

  // Semantic endpointing holds an utterance open past a final: the session
  // suppresses `utterance_end`, the floor is still the user's, and the room
  // stays on "Listening…". An island claiming "Thinking…" here would be
  // telling the user to stop talking.
  test("a final only means thinking once the utterance has closed", () => {
    expect(
      phaseForFrame(sttFinal("what's the weather"), "listening"),
    ).toBeNull();
    expect(phaseForFrame(sttFinal("what's the weather"), "transcribing")).toBe(
      "thinking",
    );
  });

  // An empty final never starts a turn — its utterance is about to be
  // discarded.
  test("an empty final moves nothing", () => {
    expect(phaseForFrame(sttFinal("   "), "transcribing")).toBeNull();
  });
});

describe("LiveActivityReporter", () => {
  test("reports a phase change once", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("thinking"));

    expect(reporter.dispatched).toEqual([
      { phase: "thinking", event: "update", detail: "" },
    ]);
  });

  // The whole reason this class exists rather than a bare fetch per frame.
  test("does not re-report a phase it is already in", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("tts_audio"));
    reporter.report(frame("tts_audio"));
    reporter.report(frame("tts_audio"));

    expect(reporter.dispatched).toEqual([
      { phase: "speaking", event: "update", detail: "" },
    ]);
  });

  test("reports each genuine transition through a turn", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("utterance_end"));
    reporter.report(sttFinal("hello there"));
    reporter.report(frame("tts_audio"));
    reporter.report(frame("tts_audio"));
    reporter.report(frame("tts_done"));

    expect(reporter.dispatched.map((d) => d.phase)).toEqual([
      "transcribing",
      "thinking",
      "speaking",
      "listening",
    ]);
  });

  test("frames that do not move the phase are ignored", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("stt_partial"));
    reporter.report(frame("ready"));

    expect(reporter.dispatched).toEqual([]);
  });

  test("ending retires the activity", () => {
    const reporter = new RecordingReporter("conv-1");
    reporter.report(frame("tts_audio"));

    reporter.end();

    expect(reporter.dispatched.at(-1)).toEqual({
      phase: "ending",
      event: "end",
      detail: "",
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
    reporter.report(frame("tts_audio"));

    expect(reporter.dispatched).toEqual([
      { phase: "ending", event: "end", detail: "" },
    ]);
  });
});

describe("LiveActivityReporter activity line", () => {
  test("carries the activity label alongside the phase it holds", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("utterance_end"));
    reporter.report(frame("thinking"));
    reporter.report(activity("Running a command"));

    expect(reporter.dispatched.at(-1)).toEqual({
      phase: "thinking",
      event: "update",
      detail: "Running a command",
    });
  });

  // A push replaces the whole content state, so the label has to ride along on
  // phase changes too, or the next phase would blank it.
  test("keeps the label through a later phase change", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("thinking"));
    reporter.report(activity("Reading a file"));
    reporter.report(frame("tts_audio"));

    expect(reporter.dispatched.at(-1)).toEqual({
      phase: "speaking",
      event: "update",
      detail: "Reading a file",
    });
  });

  test("an empty label clears the line", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("thinking"));
    reporter.report(activity("Reading a file"));
    reporter.report(activity(""));

    expect(reporter.dispatched.at(-1)?.detail).toBe("");
  });

  test("does not dispatch a label it already sent", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("thinking"));
    reporter.report(activity("Reading a file"));
    const before = reporter.dispatched.length;
    reporter.report(activity("Reading a file"));

    expect(reporter.dispatched.length).toBe(before);
  });

  // A tool can start before any phase-bearing frame lands. There is no content
  // state to attach a label to yet, and the phase that follows carries it.
  test("holds a label that arrives before any phase", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(activity("Searching the web"));
    expect(reporter.dispatched).toEqual([]);

    reporter.report(frame("thinking"));

    expect(reporter.dispatched).toEqual([
      { phase: "thinking", event: "update", detail: "Searching the web" },
    ]);
  });
});

describe("LiveActivityReporter and held utterances", () => {
  // End to end through the reporter, not just the mapping: a session using
  // semantic endpointing emits finals while the user still holds the floor.
  test("a final during a held utterance pushes nothing", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(sttFinal("i was thinking maybe"));

    expect(reporter.dispatched).toEqual([]);
  });

  test("the same final after utterance_end advances to thinking", () => {
    const reporter = new RecordingReporter("conv-1");

    reporter.report(frame("utterance_end"));
    reporter.report(sttFinal("i was thinking maybe"));

    expect(reporter.dispatched.map((d) => d.phase)).toEqual([
      "transcribing",
      "thinking",
    ]);
  });
});
