import { describe, expect, test } from "bun:test";

import { DiscordSessionState } from "./session-state.js";
import "../__tests__/test-preload.js";

// Bare, exactly as Discord returns them: `GET /gateway/bot` gives the base URL
// and READY gives `resume_gateway_url`, neither carrying query params. Pinning
// the fixtures to that shape is what makes the decoration observable — a
// pre-decorated fixture would pass whether or not the code added anything.
const BASE_URL = "wss://gateway.discord.gg";
const RESUME_URL = "wss://us-east1-b.gateway.discord.gg";
const PARAMS = "?v=10&encoding=json";
const SESSION = "8a3b1c9d4e5f";

function ready(): DiscordSessionState {
  const state = new DiscordSessionState(BASE_URL);
  state.noteReady(SESSION, RESUME_URL);
  state.noteSequence(42);
  return state;
}

describe("DiscordSessionState", () => {
  test("identifies on the base URL before any session exists", () => {
    const state = new DiscordSessionState(BASE_URL);
    expect(state.canResume).toBe(false);
    expect(state.nextConnection()).toEqual({
      url: `${BASE_URL}/${PARAMS}`,
      action: "identify",
    });
    expect(state.resumePayload()).toBeUndefined();
  });

  test("resumes on the resume URL once READY has landed", () => {
    // Discord reports that resumes against the base URL disconnect at a higher
    // rate, so the URL choice is part of the decision, not a detail.
    const state = ready();
    expect(state.nextConnection()).toEqual({
      url: `${RESUME_URL}/${PARAMS}`,
      action: "resume",
    });
    expect(state.resumePayload()).toEqual({ session_id: SESSION, seq: 42 });
  });

  test("does not double the params on an already-decorated URL", () => {
    // Discord returns these bare today, but a URL that arrives carrying them
    // must not come back with two copies — a malformed query is a connection
    // that fails for a reason nothing in the logs would explain.
    const state = new DiscordSessionState(`${BASE_URL}/${PARAMS}`);
    expect(state.nextConnection().url).toBe(`${BASE_URL}/${PARAMS}`);
  });

  test("cannot resume on READY alone — a sequence is required", () => {
    const state = new DiscordSessionState(BASE_URL);
    state.noteReady(SESSION, RESUME_URL);
    expect(state.canResume).toBe(false);
    expect(state.nextConnection().action).toBe("identify");
  });

  test("only non-null sequences advance the resume point", () => {
    // Discord sends `s: null` on every non-dispatch payload. Letting those
    // overwrite the sequence would make the next resume replay from nowhere.
    const state = ready();
    state.noteSequence(null);
    state.noteSequence(undefined);
    expect(state.resumePayload()).toEqual({ session_id: SESSION, seq: 42 });

    state.noteSequence(43);
    expect(state.resumePayload()).toEqual({ session_id: SESSION, seq: 43 });
  });

  test("invalidate drops the session and falls back to identify", () => {
    const state = ready();
    state.invalidate();
    expect(state.canResume).toBe(false);
    expect(state.nextConnection()).toEqual({
      url: `${BASE_URL}/${PARAMS}`,
      action: "identify",
    });
  });

  test("invalidate clears the sequence, not just the session id", () => {
    // A sequence from a dead session is not a valid resume point. Keeping it
    // would let a later READY combine a fresh session id with a stale sequence
    // and ask Discord to replay from a stream it no longer has.
    const state = ready();
    state.invalidate();
    state.noteReady("new-session", RESUME_URL);
    expect(state.canResume).toBe(false);

    state.noteSequence(1);
    expect(state.resumePayload()).toEqual({
      session_id: "new-session",
      seq: 1,
    });
  });

  test("prefers resume whenever one is possible", () => {
    // Resume replays missed events and costs nothing against the identify
    // budget whose breach resets the bot token.
    const state = ready();
    for (let i = 0; i < 5; i++) {
      expect(state.nextConnection().action).toBe("resume");
    }
  });
});
