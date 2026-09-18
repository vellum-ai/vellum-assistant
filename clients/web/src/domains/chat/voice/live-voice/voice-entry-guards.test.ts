/**
 * Tests for the first-run guard's one exception: the companion's introduction.
 *
 * The property under test is that exactly one surface asks the user something
 * at a time. Outside a run the first-ever entry is the preferences card's, and
 * during one it is the run's, because the run is already eight cards deep in
 * saying what the card would say and its last beat is the very press being
 * guarded.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The companion's run, which only main can start. Mocked rather than driven
 * through the bridge so each case can put the guard on either side of one.
 */
let introStaged = false;
mock.module("@/runtime/companion-intro-stage", () => ({
  companionIntroStaged: () => introStaged,
  useCompanionIntroStaged: () => introStaged,
}));

const { firstRunCardIntercepts } =
  await import("@/domains/chat/voice/live-voice/voice-entry-guards");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

beforeEach(() => {
  introStaged = false;
  useVoicePrefsStore.setState({ firstRunSeen: false });
  useLiveVoiceStore.getState().setFirstRunCardOpen(false);
});

afterEach(() => {
  introStaged = false;
});

describe("firstRunCardIntercepts", () => {
  test("takes the first-ever entry when no run is on", () => {
    expect(firstRunCardIntercepts()).toBe(true);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(true);
    // Un-consumed: a dismiss has to bring the card back on the next entry.
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
  });

  test("leaves every later entry alone", () => {
    useVoicePrefsStore.setState({ firstRunSeen: true });

    expect(firstRunCardIntercepts()).toBe(false);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(false);
  });

  test("stands down during a run, so the entry reaches a session", () => {
    introStaged = true;

    expect(firstRunCardIntercepts()).toBe(false);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(false);
  });

  /**
   * The user is about to have the conversation the card exists to precede, so
   * the card has nothing left to introduce. Returning on their next entry
   * would be the introduction asking for one more press after the finish.
   */
  test("standing down spends the first run", () => {
    introStaged = true;
    firstRunCardIntercepts();

    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);

    // And the run ending does not bring it back.
    introStaged = false;
    expect(firstRunCardIntercepts()).toBe(false);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(false);
  });

  /**
   * The exception is the run, not the companion. A press once the surface has
   * flown home is an ordinary first entry and still gets the card.
   */
  test("intercepts again outside a run for a user who never had one", () => {
    introStaged = true;
    expect(firstRunCardIntercepts()).toBe(false);

    useVoicePrefsStore.setState({ firstRunSeen: false });
    introStaged = false;

    expect(firstRunCardIntercepts()).toBe(true);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(true);
  });

  /**
   * The last beat's offer ends the run the moment it is taken, so a caller
   * that decides after a round trip finds no run on and has to say what the
   * press was made against. Main sends the `startVoice` ahead of the finish
   * for the same reason; this is the half that survives the awaits after it.
   */
  test("takes the caller's answer over the live one", () => {
    introStaged = false;

    expect(firstRunCardIntercepts(true)).toBe(false);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });

  test("and the other way, so a run on now cannot rescue a stale press", () => {
    introStaged = true;

    expect(firstRunCardIntercepts(false)).toBe(true);
    expect(useLiveVoiceStore.getState().firstRunCardOpen).toBe(true);
  });
});
