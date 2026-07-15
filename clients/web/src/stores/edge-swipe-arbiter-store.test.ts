import { describe, expect, test, beforeEach } from "bun:test";

import { useEdgeSwipeArbiterStore } from "@/stores/edge-swipe-arbiter-store";

beforeEach(() => {
  useEdgeSwipeArbiterStore.setState({ backOwnerCount: 0, openRowCount: 0 });
});

describe("useEdgeSwipeArbiterStore — back-swipe owners", () => {
  test("register/unregister balances back to zero", () => {
    const { registerBackOwner, unregisterBackOwner } =
      useEdgeSwipeArbiterStore.getState();
    registerBackOwner();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
    unregisterBackOwner();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(0);
  });

  test("count tolerates overlapping owners during route transitions", () => {
    const { registerBackOwner, unregisterBackOwner } =
      useEdgeSwipeArbiterStore.getState();
    // Incoming owner registers before the outgoing one unmounts.
    registerBackOwner();
    registerBackOwner();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(2);
    unregisterBackOwner();
    // Still suppressed while the second owner is active.
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
  });

  test("unregister floors at zero and never goes negative", () => {
    const { unregisterBackOwner } = useEdgeSwipeArbiterStore.getState();
    unregisterBackOwner();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(0);
  });
});

describe("useEdgeSwipeArbiterStore — open swipe-action rows", () => {
  test("register/unregister balances back to zero", () => {
    const { registerOpenRow, unregisterOpenRow } =
      useEdgeSwipeArbiterStore.getState();
    registerOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(1);
    unregisterOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(0);
  });

  test("count tolerates one row opening as another closes", () => {
    const { registerOpenRow, unregisterOpenRow } =
      useEdgeSwipeArbiterStore.getState();
    registerOpenRow();
    registerOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(2);
    unregisterOpenRow();
    // Drawer stays suppressed while a row is still revealed.
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(1);
  });

  test("unregister floors at zero and never goes negative", () => {
    const { unregisterOpenRow } = useEdgeSwipeArbiterStore.getState();
    unregisterOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(0);
  });
});

describe("useEdgeSwipeArbiterStore — independence of the two owner kinds", () => {
  test("open rows and back owners are tracked separately", () => {
    const { registerBackOwner, registerOpenRow, unregisterOpenRow } =
      useEdgeSwipeArbiterStore.getState();
    registerBackOwner();
    registerOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(1);

    // Closing the row leaves the back owner untouched.
    unregisterOpenRow();
    expect(useEdgeSwipeArbiterStore.getState().backOwnerCount).toBe(1);
    expect(useEdgeSwipeArbiterStore.getState().openRowCount).toBe(0);
  });
});
