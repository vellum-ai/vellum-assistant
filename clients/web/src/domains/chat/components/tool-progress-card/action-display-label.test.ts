import { afterEach, expect, test } from "bun:test";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

import {
  resolveActionDisplayLabel,
  useActionDisplayLabel,
} from "./action-display-label";

const translate = (key: string) => `localized:${key}`;

test("explicit activity takes precedence over the action and fallback", () => {
  expect(
    resolveActionDisplayLabel(
      {
        activity: "Checking the release",
        actionDisplayKey: "terminal",
        fallback: "Legacy command",
      },
      translate,
      true,
    ),
  ).toBe("Checking the release");
});

test("resolves a typed action through the localized catalog key", () => {
  expect(
    resolveActionDisplayLabel(
      { actionDisplayKey: "terminal", fallback: "Legacy command" },
      translate,
      true,
    ),
  ).toBe("localized:actionDisplay.terminal");
});

test("uses the legacy label when no activity or action is available", () => {
  expect(
    resolveActionDisplayLabel({ fallback: "Legacy command" }, translate, true),
  ).toBe("Legacy command");
});

afterEach(() => {
  cleanup();
  useAssistantFeatureFlagStore.setState({ sessionGroups: false });
});

test("disabled action wording returns the exact renderer fallback", () => {
  expect(
    resolveActionDisplayLabel(
      {
        activity: "Checking the release",
        actionDisplayKey: "terminal",
        fallback: "git status",
      },
      translate,
      false,
    ),
  ).toBe("git status");
});

test("action labels react to feature flag changes without remounting", () => {
  useAssistantFeatureFlagStore.setState({ sessionGroups: false });
  const { result } = renderHook(() => useActionDisplayLabel());
  const input = {
    actionDisplayKey: "terminal" as const,
    fallback: "git status",
  };
  expect(result.current(input)).toBe("git status");
  act(() => useAssistantFeatureFlagStore.setState({ sessionGroups: true }));
  expect(result.current(input)).toBe("Running a command");
  act(() => useAssistantFeatureFlagStore.setState({ sessionGroups: false }));
  expect(result.current(input)).toBe("git status");
});
