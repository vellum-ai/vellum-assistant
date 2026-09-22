/**
 * Which chord the run is asking this window to listen for.
 *
 * What is under test is the pair of ways it can arrive: the push main makes on
 * every change, and the pull for a window that mounted with a run already on a
 * beat. A hook that only followed the pushes would leave a reloaded window deaf
 * for the rest of the card; one that only pulled would arm a chord for a beat
 * the user has walked off.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { CompanionIntroCallControl } from "@vellumai/ipc-contract";

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));

let popout = false;
mock.module("@/runtime/popout-window", () => ({
  isPopoutWindowLifetime: () => popout,
}));

/** Main's listeners, so a case can push the way the shell would. */
const pushes: ((control: CompanionIntroCallControl | null) => void)[] = [];

/** What the pull answers, which is the beat main is holding when it is asked. */
let onLoad: CompanionIntroCallControl | null = null;

window.vellum = {
  companion: {
    getState: async () => null,
    onState: () => () => undefined,
    getIntroChord: async () => onLoad,
    onIntroChord: (
      callback: (control: CompanionIntroCallControl | null) => void,
    ) => {
      pushes.push(callback);
      return () => {
        pushes.splice(pushes.indexOf(callback), 1);
      };
    },
  },
} as unknown as Window["vellum"];

const { useCompanionIntroChord } =
  await import("@/runtime/companion-intro-chord");

const push = (control: CompanionIntroCallControl | null): void => {
  act(() => {
    for (const callback of [...pushes]) {
      callback(control);
    }
  });
};

describe("the chord the introduction asks for", () => {
  beforeEach(() => {
    popout = false;
    onLoad = null;
    pushes.length = 0;
  });

  afterEach(cleanup);

  test("asks for nothing until main names a control", () => {
    const { result } = renderHook(() => useCompanionIntroChord());

    expect(result.current).toBeNull();
  });

  test("follows main's pushes, including the one that asks for nothing", async () => {
    const { result } = renderHook(() => useCompanionIntroChord());

    push("draw");
    await waitFor(() => {
      expect(result.current).toBe("draw");
    });

    push(null);
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });

  /**
   * A window that reloads mid-beat missed the push that named the control, and
   * nothing will say it again until the run moves. Main holds the beat, so it
   * is asked.
   */
  test("carries in a beat that was already up when it mounted", async () => {
    onLoad = "mute";

    const { result } = renderHook(() => useCompanionIntroChord());

    await waitFor(() => {
      expect(result.current).toBe("mute");
    });
  });

  /**
   * The ask carries only the moment it went out. A beat walked past while it
   * was in flight has already sent the newer answer, and taking the ask's over
   * it would arm a chord for a card that is gone.
   */
  test("keeps a push that overtook the ask", async () => {
    onLoad = "share";

    const { result } = renderHook(() => useCompanionIntroChord());
    push(null);

    await waitFor(() => {
      expect(pushes.length).toBe(1);
    });
    expect(result.current).toBeNull();
  });

  /**
   * A pop-out arming this would become the host's owner of the binding and
   * take the press from the window that can publish it, since the companion
   * mirror publishes from the app's window alone.
   */
  test("says nothing in a pop-out window", async () => {
    popout = true;
    onLoad = "share";

    const { result } = renderHook(() => useCompanionIntroChord());

    expect(pushes.length).toBe(0);
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
