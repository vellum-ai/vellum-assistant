import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  clearPendingVoiceModeStart,
  consumePendingVoiceModeStart,
  requestVoiceModeStart,
} from "@/domains/chat/voice/pending-voice-start";

afterEach(() => {
  setSystemTime();
  clearPendingVoiceModeStart();
});

describe("pending voice start", () => {
  test("is one-shot: the second composer to mount starts nothing", () => {
    requestVoiceModeStart();

    expect(consumePendingVoiceModeStart()).toBe(true);
    expect(consumePendingVoiceModeStart()).toBe(false);
  });

  test("reports nothing pending when none was requested", () => {
    expect(consumePendingVoiceModeStart()).toBe(false);
  });

  test("expires, so a request that never reached a composer cannot fire later", () => {
    // The user binds a shortcut, presses it where voice is unavailable, and
    // opens a chat much later. Voice opening then would read as the app acting
    // on its own.
    setSystemTime(new Date("2026-08-18T12:00:00Z"));
    requestVoiceModeStart();

    setSystemTime(new Date("2026-08-18T12:00:30Z"));

    expect(consumePendingVoiceModeStart()).toBe(false);
  });

  test("survives the wait for a route to mount its composer", () => {
    setSystemTime(new Date("2026-08-18T12:00:00Z"));
    requestVoiceModeStart();

    setSystemTime(new Date("2026-08-18T12:00:02Z"));

    expect(consumePendingVoiceModeStart()).toBe(true);
  });

  test("clear drops a pending request", () => {
    requestVoiceModeStart();
    clearPendingVoiceModeStart();

    expect(consumePendingVoiceModeStart()).toBe(false);
  });
});
