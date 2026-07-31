/**
 * Tests for `BACKGROUND_TASK_DESCRIPTOR` — the count-less background-process
 * descriptor for bash / host_bash tasks.
 *
 * Drives the real background-task store and asserts:
 *  - `useCardSummary` projects a seeded entry into `{ state, title, info }`
 *    with NO `count` (the defining trait of this kind), and passes `null`
 *    through when the entry is missing (the start race).
 *  - the static metadata (kind, pill variant, overlay/aria copy) matches the
 *    existing background-task overlay surface.
 *
 * `background-task-actions` is mocked so importing the descriptor (which wires
 * `onStop` to `stopBackgroundTask`) doesn't pull in the daemon SDK.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

mock.module("@/domains/chat/utils/background-task-actions", () => ({
  stopBackgroundTask: async () => {},
}));

import { BACKGROUND_TASK_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/background-task";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useViewerStore } from "@/stores/viewer-store";

const NOW = 1700000000000;

function start(id: string, command = "ls -la"): void {
  useBackgroundTaskStore.getState().startTask({
    type: "background_tool_started",
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command,
    startedAt: NOW,
  });
}

beforeEach(() => {
  useBackgroundTaskStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useViewerStore.getState().reset();
});

describe("BACKGROUND_TASK_DESCRIPTOR — useCardSummary", () => {
  test("projects a running task into a count-less CardSummary", () => {
    start("bg-1", "npm run build");

    const { result } = renderHook(() =>
      BACKGROUND_TASK_DESCRIPTOR.useCardSummary("bg-1"),
    );

    expect(result.current).toEqual({
      state: "loading",
      title: "Running command",
      info: "npm run build",
    });
    // The defining trait of this kind: no unit count.
    expect(result.current?.count).toBeUndefined();
  });

  test("passes null through when no entry exists yet (start race)", () => {
    const { result } = renderHook(() =>
      BACKGROUND_TASK_DESCRIPTOR.useCardSummary("missing"),
    );

    expect(result.current).toBeNull();
  });
});

describe("BACKGROUND_TASK_DESCRIPTOR — metadata", () => {
  test("is the background-task kind", () => {
    expect(BACKGROUND_TASK_DESCRIPTOR.kind).toBe("background-task");
  });

  test("uses a stacked pill (terminal glyphs, no count chip)", () => {
    expect(BACKGROUND_TASK_DESCRIPTOR.pill.variant).toBe("stacked");
  });

  test("formats the overlay title with command pluralization", () => {
    expect(BACKGROUND_TASK_DESCRIPTOR.overlayTitle(1)).toBe("1 Active Command");
    expect(BACKGROUND_TASK_DESCRIPTOR.overlayTitle(3)).toBe(
      "3 Active Commands",
    );
  });

  test("exposes the active-commands aria labels", () => {
    expect(BACKGROUND_TASK_DESCRIPTOR.pillAriaLabel(2)).toBe("Active commands");
    expect(BACKGROUND_TASK_DESCRIPTOR.openCardAriaLabel).toBe("Open command");
  });

  test("supports stopping a task", () => {
    expect(typeof BACKGROUND_TASK_DESCRIPTOR.onStop).toBe("function");
  });
});

describe("BACKGROUND_TASK_DESCRIPTOR — onOpenDetail", () => {
  test("opens the background-task detail panel through the openProcessDetail facade", () => {
    // The descriptor routes through `openProcessDetail({ kind, id })`, which
    // delegates to `openBackgroundTaskDetail` — assert the resulting state.
    BACKGROUND_TASK_DESCRIPTOR.onOpenDetail("bg-1");

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("background-task-detail");
    expect(state.activeBackgroundTaskId).toBe("bg-1");
  });
});
