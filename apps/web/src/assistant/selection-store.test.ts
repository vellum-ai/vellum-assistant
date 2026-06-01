import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantSelectionStore } from "./selection-store";

afterEach(() => {
  useAssistantSelectionStore.setState({ activeAssistantId: null });
});

describe("useAssistantSelectionStore", () => {
  test("starts with no active assistant", () => {
    expect(useAssistantSelectionStore.getState().activeAssistantId).toBeNull();
  });

  test("setActiveAssistantId stores the id", () => {
    useAssistantSelectionStore.getState().setActiveAssistantId("asst-1");
    expect(useAssistantSelectionStore.getState().activeAssistantId).toBe(
      "asst-1",
    );
  });

  test("setActiveAssistantId(null) clears the id", () => {
    useAssistantSelectionStore.getState().setActiveAssistantId("asst-1");
    useAssistantSelectionStore.getState().setActiveAssistantId(null);
    expect(useAssistantSelectionStore.getState().activeAssistantId).toBeNull();
  });
});
