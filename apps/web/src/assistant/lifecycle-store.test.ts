import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantLifecycleStore } from "./lifecycle-store";

afterEach(() => {
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "loading" },
    autoGreetPending: false,
  });
});

describe("useAssistantLifecycleStore", () => {
  test("starts in the loading phase with no pending greet", () => {
    const s = useAssistantLifecycleStore.getState();
    expect(s.assistantState).toEqual({ kind: "loading" });
    expect(s.autoGreetPending).toBe(false);
  });

  test("setState replaces the discriminated state", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
    });
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "active",
      isLocal: false,
    });
  });

  test("autoGreetPending is independently togglable", () => {
    useAssistantLifecycleStore.setState({ autoGreetPending: true });
    expect(useAssistantLifecycleStore.getState().autoGreetPending).toBe(true);
    useAssistantLifecycleStore.setState({ autoGreetPending: false });
    expect(useAssistantLifecycleStore.getState().autoGreetPending).toBe(false);
  });
});
