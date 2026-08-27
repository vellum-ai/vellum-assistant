/**
 * `finishActiveDictation` is what makes Send mean "finish, then send" while
 * dictation is live (LUM-3432). It has to stop the session, wait for the
 * transcript to reach the composer, and tell the caller whether any words
 * actually arrived. Uses the real recording store, reset between tests.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { finishActiveDictation } from "@/domains/chat/voice/finish-dictation";
import { registerPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";

const store = useVoiceRecordingStore;

/** Registers a stop handler and returns its unregister for cleanup. */
function withTarget(stop: () => void): () => void {
  return registerPushToTalkTarget({ start: () => {}, stop });
}

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  store.getState().reset();
});

describe("finishActiveDictation", () => {
  test("does nothing when no session is in flight", async () => {
    let stopped = false;
    unregister = withTarget(() => {
      stopped = true;
    });

    expect(await finishActiveDictation()).toBe("none");
    expect(stopped).toBe(false);
  });

  test("stops a live session and reports the transcript delivered", async () => {
    store.getState().startRecording();
    unregister = withTarget(() => {
      store.getState().stopRecording();
      // The button writes the transcript into the composer and only then
      // finalizes, so `done` is the signal that the draft holds the words.
      setTimeout(() => store.getState().finalize(), 0);
    });

    expect(await finishActiveDictation(1000)).toBe("delivered");
  });

  test("settles even when the stop finalizes synchronously", async () => {
    store.getState().startRecording();
    unregister = withTarget(() => {
      store.getState().stopRecording();
      store.getState().finalize();
    });

    expect(await finishActiveDictation(1000)).toBe("delivered");
  });

  test("reports no transcript when the session fails", async () => {
    store.getState().startRecording();
    unregister = withTarget(() => {
      store.getState().stopRecording();
      setTimeout(() => store.getState().fail("audio-capture"), 0);
    });

    expect(await finishActiveDictation(1000)).toBe("no-transcript");
  });

  test("reports no transcript when the session ends with nothing to insert", async () => {
    store.getState().startRecording();
    unregister = withTarget(() => {
      store.getState().stopRecording();
      // The empty/cancelled paths reset straight back to idle.
      setTimeout(() => store.getState().reset(), 0);
    });

    expect(await finishActiveDictation(1000)).toBe("no-transcript");
  });

  test("gives up rather than guessing when the stop never lands", async () => {
    store.getState().startRecording();
    // A stop pressed on an instance that owns no recorder is a no-op, so the
    // phase never moves.
    unregister = withTarget(() => {});

    expect(await finishActiveDictation(20)).toBe("no-transcript");
  });

  test("waits out a session already transcribing without stopping it again", async () => {
    store.getState().startRecording();
    store.getState().stopRecording();
    let stopped = false;
    unregister = withTarget(() => {
      stopped = true;
    });
    setTimeout(() => store.getState().finalize(), 0);

    expect(await finishActiveDictation(1000)).toBe("delivered");
    expect(stopped).toBe(false);
  });
});
