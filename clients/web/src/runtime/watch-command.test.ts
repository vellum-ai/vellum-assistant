import { afterEach, describe, expect, mock, test } from "bun:test";

const toggleWatchMock = mock(() => Promise.resolve());

mock.module("@/domains/chat/watch/watch-controller", () => ({
  toggleWatch: toggleWatchMock,
}));

const { handleToggleWatchCommand, isWatchEnabled } =
  await import("./watch-command");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

/** The evaluation the client flag store is holding when a press lands. */
const setWatchFlag = (value: boolean | undefined): void => {
  useClientFeatureFlagStore.setState({ watch: value } as never);
};

afterEach(() => {
  toggleWatchMock.mockClear();
  setWatchFlag(false);
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
   * this side is the only one that knows which edge a press is. So the gate
   * cannot be "start only": it is the same door either way, and a flag turned
   * off mid-session must not be what strands a capture with nothing to end it.
   * A running session is ended from the surface's stop control, which reaches
   * this same command.
   */
  test("stays one call for both edges", () => {
    setWatchFlag(true);

    handleToggleWatchCommand();
    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(2);
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
