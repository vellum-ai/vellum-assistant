import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantLifecycleStore } from "./lifecycle-store";

const NOOP_CHECK = async () => {};
const NOOP_VOID = () => {};

afterEach(() => {
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "loading" },
    checkAssistant: NOOP_CHECK,
    retryAssistant: NOOP_VOID,
    hatchVersion: NOOP_VOID,
  });
});

describe("useAssistantLifecycleStore", () => {
  test("starts in loading state with no-op imperative actions", () => {
    const s = useAssistantLifecycleStore.getState();
    expect(s.assistantState).toEqual({ kind: "loading" });
    expect(typeof s.checkAssistant).toBe("function");
    expect(typeof s.retryAssistant).toBe("function");
    expect(typeof s.hatchVersion).toBe("function");
  });

  test("setAssistantState replaces the discriminated state", () => {
    useAssistantLifecycleStore
      .getState()
      .setAssistantState({ kind: "active", isLocal: false });
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "active",
      isLocal: false,
    });
  });

  test("registerImperativeActions swaps in real callbacks", () => {
    const check = async () => {};
    const retry = () => {};
    const hatch = (_v?: string) => {};
    useAssistantLifecycleStore.getState().registerImperativeActions({
      checkAssistant: check,
      retryAssistant: retry,
      hatchVersion: hatch,
    });
    const s = useAssistantLifecycleStore.getState();
    expect(s.checkAssistant).toBe(check);
    expect(s.retryAssistant).toBe(retry);
    expect(s.hatchVersion).toBe(hatch);
  });
});
