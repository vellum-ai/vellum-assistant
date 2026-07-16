import { beforeEach, describe, expect, test } from "bun:test";

import {
  FULL_UNLOCK_COUNT,
  isNavItemGated,
  QUIET_UNLOCK_ATTEMPTS,
  useNavGateStore,
  type NavGateItemId,
} from "@/domains/chat/nav-gate/nav-gate-store";

const ALL_ITEMS: NavGateItemId[] = [
  "library",
  "new-conversation",
  "history",
  "settings",
];

function reset() {
  useNavGateStore.setState({
    sentCount: 0,
    attempts: {},
    collapseApplied: false,
    bubbleItem: null,
    bubbleAnchor: null,
    pendingSend: null,
  });
}

beforeEach(reset);

describe("isNavItemGated — the unlock curve", () => {
  test("non-gated arms never gate", () => {
    for (const arm of ["none", "control"] as const) {
      for (const item of ALL_ITEMS) {
        expect(isNavItemGated(arm, item, { sentCount: 0, attempts: {} })).toBe(
          false,
        );
      }
    }
  });

  test("0 messages: everything gated", () => {
    for (const item of ALL_ITEMS) {
      expect(isNavItemGated("gated", item, { sentCount: 0, attempts: {} })).toBe(
        true,
      );
    }
  });

  test("1 message: nav spine unlocks, library/settings stay gated", () => {
    const state = { sentCount: 1, attempts: {} };
    expect(isNavItemGated("gated", "history", state)).toBe(false);
    expect(isNavItemGated("gated", "new-conversation", state)).toBe(false);
    expect(isNavItemGated("gated", "library", state)).toBe(true);
    expect(isNavItemGated("gated", "settings", state)).toBe(true);
  });

  test("5 messages: full chrome, experiment over", () => {
    for (const item of ALL_ITEMS) {
      expect(
        isNavItemGated("gated", item, {
          sentCount: FULL_UNLOCK_COUNT,
          attempts: {},
        }),
      ).toBe(false);
    }
  });

  test("quiet-unlocked item is ungated while others stay gated", () => {
    const state = {
      sentCount: 0,
      attempts: { library: QUIET_UNLOCK_ATTEMPTS },
    };
    expect(isNavItemGated("gated", "library", state)).toBe(false);
    expect(isNavItemGated("gated", "settings", state)).toBe(true);
  });
});

describe("registerGatedClick", () => {
  test("first two clicks bubble with attempt tracking, third unlocks", () => {
    const store = useNavGateStore.getState();
    expect(store.registerGatedClick("settings", null)).toBe("bubble");
    expect(useNavGateStore.getState().bubbleItem).toBe("settings");
    expect(useNavGateStore.getState().registerGatedClick("settings", null)).toBe(
      "bubble",
    );
    expect(useNavGateStore.getState().attempts.settings).toBe(2);
    expect(useNavGateStore.getState().registerGatedClick("settings", null)).toBe(
      "unlock",
    );
    expect(useNavGateStore.getState().bubbleItem).toBeNull();
  });

  test("attempts are tracked per item", () => {
    useNavGateStore.getState().registerGatedClick("library", null);
    useNavGateStore.getState().registerGatedClick("settings", null);
    expect(useNavGateStore.getState().attempts).toEqual({
      library: 1,
      settings: 1,
    });
  });
});

describe("message counting", () => {
  test("increments and caps just past the full-unlock threshold", () => {
    for (let i = 0; i < FULL_UNLOCK_COUNT + 5; i++) {
      useNavGateStore.getState().recordMessageSent();
    }
    expect(useNavGateStore.getState().sentCount).toBe(FULL_UNLOCK_COUNT + 1);
  });
});

describe("pending send channel", () => {
  test("requestSend stages once and closes the bubble; consume is one-shot", () => {
    useNavGateStore.getState().registerGatedClick("library", null);
    useNavGateStore.getState().requestSend("Let's switch topics.");
    expect(useNavGateStore.getState().bubbleItem).toBeNull();
    expect(useNavGateStore.getState().consumePendingSend()).toEqual({
      text: "Let's switch topics.",
    });
    expect(useNavGateStore.getState().consumePendingSend()).toBeNull();
  });
});
