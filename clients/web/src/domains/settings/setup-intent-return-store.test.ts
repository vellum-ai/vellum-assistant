/**
 * Tests for `useSetupIntentReturnStore`'s generation gating: the resolution
 * that fills this store runs across a full page load and can be abandoned
 * mid-flight when the request scope changes, so anything it publishes
 * afterwards has to be recognized as stale and dropped.
 *
 * Driven through the store's non-React API, the way the resolution drives it.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { useSetupIntentReturnStore } from "@/domains/settings/setup-intent-return-store";

const SAVED = {
  kind: "saved",
  card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
} as const;

beforeEach(() => {
  useSetupIntentReturnStore.setState({
    pending: false,
    outcome: null,
    scopeKey: null,
    generation: 0,
  });
});

describe("useSetupIntentReturnStore", () => {
  test("beginResolving opens the pending window under a fresh generation", () => {
    const first = useSetupIntentReturnStore.getState().beginResolving();
    const second = useSetupIntentReturnStore.getState().beginResolving();

    expect(second).toBeGreaterThan(first);
    expect(useSetupIntentReturnStore.getState().pending).toBe(true);
    expect(useSetupIntentReturnStore.getState().outcome).toBeNull();
  });

  test("settleOutcome publishes the outcome and the scope it resolved under", () => {
    const generation = useSetupIntentReturnStore.getState().beginResolving();

    useSetupIntentReturnStore
      .getState()
      .settleOutcome(SAVED, "user:u_1:org:org_1", generation);

    const state = useSetupIntentReturnStore.getState();
    expect(state.pending).toBe(false);
    expect(state.outcome).toEqual(SAVED);
    expect(state.scopeKey).toBe("user:u_1:org:org_1");
  });

  test("abandonResolution ends the pending window and bumps the generation", () => {
    const generation = useSetupIntentReturnStore.getState().beginResolving();

    useSetupIntentReturnStore.getState().abandonResolution(generation);

    const state = useSetupIntentReturnStore.getState();
    expect(state.pending).toBe(false);
    expect(state.outcome).toBeNull();
    expect(state.scopeKey).toBeNull();
    expect(state.generation).toBeGreaterThan(generation);
  });

  test("ignores a settle from an abandoned resolution", () => {
    const generation = useSetupIntentReturnStore.getState().beginResolving();
    useSetupIntentReturnStore.getState().abandonResolution(generation);

    useSetupIntentReturnStore
      .getState()
      .settleOutcome(SAVED, "user:u_1:org:org_1", generation);

    const state = useSetupIntentReturnStore.getState();
    expect(state.outcome).toBeNull();
    expect(state.scopeKey).toBeNull();
  });

  test("ignores a discard from an abandoned resolution", () => {
    // A late discard must not reopen or reword the state a newer resolution
    // has already claimed.
    const stale = useSetupIntentReturnStore.getState().beginResolving();
    useSetupIntentReturnStore.getState().abandonResolution(stale);
    const current = useSetupIntentReturnStore.getState().beginResolving();

    useSetupIntentReturnStore.getState().discardResolution(stale);

    expect(useSetupIntentReturnStore.getState().pending).toBe(true);
    expect(useSetupIntentReturnStore.getState().generation).toBe(current);
  });

  test("ignores an abandon from a resolution that was already superseded", () => {
    // A stale watcher must not tear down the pending window a newer resolution
    // opened.
    const stale = useSetupIntentReturnStore.getState().beginResolving();
    useSetupIntentReturnStore.getState().abandonResolution(stale);
    const current = useSetupIntentReturnStore.getState().beginResolving();

    useSetupIntentReturnStore.getState().abandonResolution(stale);

    expect(useSetupIntentReturnStore.getState().pending).toBe(true);
    expect(useSetupIntentReturnStore.getState().generation).toBe(current);
  });

  test("clearOutcome leaves a resolved return resolved", () => {
    const generation = useSetupIntentReturnStore.getState().beginResolving();
    useSetupIntentReturnStore
      .getState()
      .settleOutcome(SAVED, "user:u_1:org:org_1", generation);

    useSetupIntentReturnStore.getState().clearOutcome();

    const state = useSetupIntentReturnStore.getState();
    expect(state.outcome).toBeNull();
    expect(state.scopeKey).toBeNull();
    expect(state.pending).toBe(false);
  });
});
