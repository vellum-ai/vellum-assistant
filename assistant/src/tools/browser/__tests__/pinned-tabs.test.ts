import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetPinnedTabsForTests,
  clearPinnedTab,
  clearPinnedTabByTabId,
  getPinnedTab,
  setPinnedTab,
} from "../pinned-tabs.js";

describe("pinned-tabs", () => {
  afterEach(() => {
    __resetPinnedTabsForTests();
  });

  test("setPinnedTab / getPinnedTab round-trips", () => {
    setPinnedTab("conv-a", "42");
    expect(getPinnedTab("conv-a")).toBe("42");
  });

  test("getPinnedTab returns undefined for unset conversation", () => {
    expect(getPinnedTab("unset-conv")).toBeUndefined();
  });

  test("conversations have independent pins", () => {
    setPinnedTab("conv-a", "42");
    setPinnedTab("conv-b", "99");
    expect(getPinnedTab("conv-a")).toBe("42");
    expect(getPinnedTab("conv-b")).toBe("99");
  });

  test("setPinnedTab overwrites a prior pin for the same conversation", () => {
    setPinnedTab("conv-a", "42");
    setPinnedTab("conv-a", "100");
    expect(getPinnedTab("conv-a")).toBe("100");
  });

  test("clearPinnedTab removes the pin", () => {
    setPinnedTab("conv-a", "42");
    clearPinnedTab("conv-a");
    expect(getPinnedTab("conv-a")).toBeUndefined();
  });

  test("clearPinnedTab on a non-existent conversation is a no-op", () => {
    // Should not throw or affect other conversations.
    setPinnedTab("conv-a", "42");
    clearPinnedTab("nonexistent");
    expect(getPinnedTab("conv-a")).toBe("42");
  });

  test("clearPinnedTabByTabId clears every matching conversation", () => {
    setPinnedTab("conv-a", "42");
    setPinnedTab("conv-b", "42");
    setPinnedTab("conv-c", "99");

    const cleared = clearPinnedTabByTabId("42");

    expect(cleared).toBe(2);
    expect(getPinnedTab("conv-a")).toBeUndefined();
    expect(getPinnedTab("conv-b")).toBeUndefined();
    expect(getPinnedTab("conv-c")).toBe("99"); // unchanged
  });

  test("clearPinnedTabByTabId on a non-matching tab is a no-op returning 0", () => {
    setPinnedTab("conv-a", "42");
    const cleared = clearPinnedTabByTabId("999");
    expect(cleared).toBe(0);
    expect(getPinnedTab("conv-a")).toBe("42");
  });

  test("empty conversationId is rejected on set", () => {
    setPinnedTab("", "42");
    expect(getPinnedTab("")).toBeUndefined();
  });

  test("empty tabId is rejected on set", () => {
    setPinnedTab("conv-a", "");
    expect(getPinnedTab("conv-a")).toBeUndefined();
  });

  describe("cross-client isolation (#31361)", () => {
    test("same tabId on different clients are stored independently", () => {
      setPinnedTab("conv-a", "99", "clientA");
      setPinnedTab("conv-a", "99", "clientB");
      expect(getPinnedTab("conv-a", "clientA")).toBe("99");
      expect(getPinnedTab("conv-a", "clientB")).toBe("99");
    });

    test("clearPinnedTabByTabId with clientId only clears that client", () => {
      setPinnedTab("conv-a", "99", "clientA");
      setPinnedTab("conv-b", "99", "clientB");

      const cleared = clearPinnedTabByTabId("99", "clientA");

      expect(cleared).toBe(1);
      expect(getPinnedTab("conv-a", "clientA")).toBeUndefined();
      expect(getPinnedTab("conv-b", "clientB")).toBe("99"); // clientB's pin survives
    });

    test("getPinnedTab with matching clientId returns correct tabId", () => {
      setPinnedTab("conv-x", "42", "clientA");
      setPinnedTab("conv-x", "77", "clientB");

      expect(getPinnedTab("conv-x", "clientA")).toBe("42");
      expect(getPinnedTab("conv-x", "clientB")).toBe("77");
    });

    test("clearPinnedTabByTabId without clientId clears all matching entries (backward compat)", () => {
      setPinnedTab("conv-a", "99", "clientA");
      setPinnedTab("conv-b", "99", "clientB");

      const cleared = clearPinnedTabByTabId("99");

      expect(cleared).toBe(2);
      expect(getPinnedTab("conv-a", "clientA")).toBeUndefined();
      expect(getPinnedTab("conv-b", "clientB")).toBeUndefined();
    });

    test("clearPinnedTab with clientId only removes that client slot", () => {
      setPinnedTab("conv-a", "42", "clientA");
      setPinnedTab("conv-a", "77", "clientB");

      clearPinnedTab("conv-a", "clientA");

      expect(getPinnedTab("conv-a", "clientA")).toBeUndefined();
      expect(getPinnedTab("conv-a", "clientB")).toBe("77");
    });

    test("clearPinnedTab without clientId removes all slots", () => {
      setPinnedTab("conv-a", "42", "clientA");
      setPinnedTab("conv-a", "77", "clientB");

      clearPinnedTab("conv-a");

      expect(getPinnedTab("conv-a", "clientA")).toBeUndefined();
      expect(getPinnedTab("conv-a", "clientB")).toBeUndefined();
    });

    test("getPinnedTab with unknown clientId falls back to __default__ slot", () => {
      setPinnedTab("conv-a", "42"); // stored in __default__ slot
      expect(getPinnedTab("conv-a", "clientA")).toBe("42");
    });

    test("getPinnedTab without clientId returns first entry", () => {
      setPinnedTab("conv-a", "42", "clientA");
      const result = getPinnedTab("conv-a");
      expect(result).toBe("42");
    });
  });
});
