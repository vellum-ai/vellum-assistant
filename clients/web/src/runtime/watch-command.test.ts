import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * The controller's session slot, stood in for.
 *
 * Toggled by the stub the way the real `toggleWatch` toggles it, so a press
 * that starts a session leaves the next press on the stop edge. The command
 * reads the slot to decide which edge a press is, so a stub that never moved
 * would only ever exercise the start edge.
 */
let sessionActive = false;

const toggleWatchMock = mock(() => {
  sessionActive = !sessionActive;
  return Promise.resolve();
});

mock.module("@/domains/chat/watch/watch-controller", () => ({
  toggleWatch: toggleWatchMock,
  isWatchSessionActive: () => sessionActive,
}));

const { handleToggleWatchCommand, isWatchEnabled } =
  await import("./watch-command");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

/** The evaluation the client flag store is holding when a press lands. */
const setWatchFlag = (value: boolean | undefined): void => {
  useClientFeatureFlagStore.setState({ teach: value } as never);
};

afterEach(() => {
  toggleWatchMock.mockClear();
  setWatchFlag(false);
  sessionActive = false;
});

/**
 * The command is the door, and the companion surface's control is only the
 * affordance in front of it.
 *
 * Hiding a button in another window is not closing a door: that window has its
 * own lifetime and its own copy of the state, so a press already in flight or a
 * surface that has not heard the flag move reaches this channel all the same.
 * This window owns the session, so the refusal has to be here.
 */
describe("the toggleWatch command", () => {
  test("starts nothing while the flag is off", () => {
    setWatchFlag(false);

    handleToggleWatchCommand();

    expect(toggleWatchMock).not.toHaveBeenCalled();
  });

  /**
   * Every state that is not a positive evaluation is a refusal, which is what
   * covers a window whose flags have not synced yet and an environment where
   * the flag was never provisioned.
   */
  test("starts nothing while the flag is unknown", () => {
    setWatchFlag(undefined);

    handleToggleWatchCommand();

    expect(toggleWatchMock).not.toHaveBeenCalled();
  });

  test("toggles the session while the flag is on", () => {
    setWatchFlag(true);

    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Both edges through the one call, because the surface draws one control and
   * this side is the only one that knows which edge a press is.
   */
  test("stays one call for both edges", () => {
    setWatchFlag(true);

    handleToggleWatchCommand();
    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The whole reason the gate is on the start edge alone.
   *
   * A flag turned off under a session that is already running does not hide the
   * companion surface's control: the surface swaps Watch for the stop control,
   * because a capture the user can see and cannot end is worse than the feature
   * staying visible. That stop control presses this command, so a gate that ran
   * ahead of the stop edge would leave the microphone and the screen reading
   * open with every visible press of stop doing nothing.
   */
  test("stops a running session while the flag is off", () => {
    sessionActive = true;
    setWatchFlag(false);

    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
    expect(sessionActive).toBe(false);
  });

  /** The same, for the state of never having had an answer at all. */
  test("stops a running session while the flag is unknown", () => {
    sessionActive = true;
    setWatchFlag(undefined);

    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
    expect(sessionActive).toBe(false);
  });

  /**
   * The stop edge is the only thing a running session buys. Once it has ended,
   * the next press is a start again and the flag is back in front of it.
   */
  test("will not restart what it just stopped while the flag is off", () => {
    sessionActive = true;
    setWatchFlag(false);

    handleToggleWatchCommand();
    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the Watch flag predicate", () => {
  test("is off when the store holds no answer", () => {
    setWatchFlag(undefined);
    expect(isWatchEnabled()).toBe(false);
  });

  test("is off when the answer is no", () => {
    setWatchFlag(false);
    expect(isWatchEnabled()).toBe(false);
  });

  test("is on when the answer is yes", () => {
    setWatchFlag(true);
    expect(isWatchEnabled()).toBe(true);
  });
});
