import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantLifecycleStore } from "./lifecycle-store";

afterEach(() => {
  useAssistantLifecycleStore.setState({ assistantState: { kind: "loading" } });
});

describe("useAssistantLifecycleStore", () => {
  test("starts in the loading phase", () => {
    expect(useAssistantLifecycleStore.getState().assistantState).toEqual({
      kind: "loading",
    });
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
});
