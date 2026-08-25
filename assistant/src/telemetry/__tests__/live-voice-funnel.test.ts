import { describe, expect, it } from "bun:test";

import {
  liveVoiceEndScreen,
  liveVoiceSilenceReason,
} from "../live-voice-funnel.js";

describe("liveVoiceSilenceReason", () => {
  it("blames the transport when the session never went active", () => {
    // Nothing after `ready` can be held against a session that never got
    // there: the user had no chance to speak.
    expect(
      liveVoiceSilenceReason({
        reachedActive: false,
        audioInput: true,
        receivedAudio: false,
        detectedSpeech: false,
      }),
    ).toBe("no_ready");
  });

  it("blames the transport even if stray audio arrived first", () => {
    // Audio can land before the preflight resolves. The session still never
    // became usable, and reporting that as a microphone problem would send
    // someone looking in the wrong layer.
    expect(
      liveVoiceSilenceReason({
        reachedActive: false,
        audioInput: true,
        receivedAudio: true,
        detectedSpeech: true,
      }),
    ).toBe("no_ready");
  });

  it("reports a microphone that never opened", () => {
    expect(
      liveVoiceSilenceReason({
        reachedActive: true,
        audioInput: true,
        receivedAudio: false,
        detectedSpeech: false,
      }),
    ).toBe("no_audio");
  });

  it("separates a mic that opened but carried no speech", () => {
    // The distinction that makes this taxonomy worth having: a denied
    // permission and a muted mic both produce a silent session, and only this
    // pair of flags tells them apart.
    expect(
      liveVoiceSilenceReason({
        reachedActive: true,
        audioInput: true,
        receivedAudio: true,
        detectedSpeech: false,
      }),
    ).toBe("no_speech");
  });

  it("does not blame the microphone on a session that never had one", () => {
    // A text-only session opened because speech-to-text was unavailable and
    // the client could type. Scoring the absent microphone as `no_audio` would
    // file it under a failure it does not have, and inflate the very rate this
    // taxonomy exists to explain.
    expect(
      liveVoiceSilenceReason({
        reachedActive: true,
        audioInput: false,
        receivedAudio: false,
        detectedSpeech: false,
      }),
    ).toBe("text_only");
  });

  it("still reports text_only when a text-only session streamed stray audio", () => {
    // A client that has not caught up with `audioInput: false` may keep
    // sending chunks. Nothing transcribes them, so they say nothing about why
    // the session was silent, and the reason must not flip on their account.
    expect(
      liveVoiceSilenceReason({
        reachedActive: true,
        audioInput: false,
        receivedAudio: true,
        detectedSpeech: true,
      }),
    ).toBe("text_only");
  });

  it("reports speech that never became a turn", () => {
    expect(
      liveVoiceSilenceReason({
        reachedActive: true,
        audioInput: true,
        receivedAudio: true,
        detectedSpeech: true,
      }),
    ).toBe("no_turn");
  });
});

describe("liveVoiceEndScreen", () => {
  it("carries the close reason alone when nothing else applies", () => {
    expect(liveVoiceEndScreen("client_end")).toBe("ended_client_end");
  });

  it("carries a failure code in the detail slot", () => {
    expect(liveVoiceEndScreen("error", "invalid_field")).toBe(
      "ended_error:invalid_field",
    );
  });

  it("carries a silence reason when the session merely produced nothing", () => {
    expect(liveVoiceEndScreen("client_end", null, "no_audio")).toBe(
      "ended_client_end:silent_no_audio",
    );
  });

  it("prefers the failure code when a session both failed and was silent", () => {
    // A session that died on an error is explained by the error; its silence
    // is a consequence, not a second finding.
    expect(liveVoiceEndScreen("error", "invalid_field", "no_audio")).toBe(
      "ended_error:invalid_field",
    );
  });

  it("keeps every combination inside the wire field's 64-char bound", () => {
    // `screen` is capped at 64 chars by the ingest serializer and an over-long
    // value is dropped silently, taking the whole row with it.
    const longest = liveVoiceEndScreen("transport_closed", null, "no_speech");
    expect(longest.length).toBeLessThanOrEqual(64);
  });

  it("prefixes the silence value so it reads correctly in a mislabelled column", () => {
    // It shares the detail slot with failure codes, and the admin dashboard
    // renders that slot under a "failure code" header until it learns the
    // difference. The prefix keeps the value honest meanwhile.
    expect(liveVoiceEndScreen("client_end", null, "no_turn")).toContain(
      "silent_",
    );
  });
});
