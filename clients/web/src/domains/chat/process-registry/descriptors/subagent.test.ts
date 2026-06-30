/**
 * Tests for `SUBAGENT_DESCRIPTOR` — the subagent {@link BackgroundProcessDescriptor}.
 *
 * The `useCardSummary` projection is driven against the real `useSubagentStore`
 * (seeded via `spawnSubagent` / `loadDetail` / `changeStatus`) so it exercises
 * the same `ToolCallCardData → CardSummary` mapping a consumer would observe.
 * The static copy/config fields (`kind`, `overlayTitle`, `pill`, aria labels)
 * are asserted directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { SUBAGENT_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/subagent";
import {
  useSubagentStore,
  type SubagentTimelineEvent,
} from "@/domains/chat/subagent-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

const NOW = 1700000000000;

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
  useViewerStore.getState().reset();
});

/** Spawn a subagent, seed its timeline events, and move it to `status`. */
function seed(
  subagentId: string,
  status: SubagentStatus,
  events: SubagentTimelineEvent[] = [],
  label = "Research Agent",
) {
  const store = useSubagentStore.getState();
  store.spawnSubagent({ subagentId, label, objective: "test", timestamp: NOW });
  if (events.length > 0) store.loadDetail({ subagentId, events });
  store.changeStatus({ subagentId, status });
}

describe("SUBAGENT_DESCRIPTOR — static config", () => {
  test("kind is subagent", () => {
    expect(SUBAGENT_DESCRIPTOR.kind).toBe("subagent");
  });

  test("overlayTitle pluralises on count", () => {
    expect(SUBAGENT_DESCRIPTOR.overlayTitle(1)).toBe("1 Active Subagent");
    expect(SUBAGENT_DESCRIPTOR.overlayTitle(2)).toBe("2 Active Subagents");
  });

  test("pill is a stacked variant", () => {
    expect(SUBAGENT_DESCRIPTOR.pill.variant).toBe("stacked");
  });

  test("exposes the subagent aria labels", () => {
    expect(SUBAGENT_DESCRIPTOR.openCardAriaLabel).toBe("Open subagent");
    expect(SUBAGENT_DESCRIPTOR.pillAriaLabel(3)).toBe("Active subagents");
  });
});

describe("SUBAGENT_DESCRIPTOR — onOpenDetail", () => {
  test("opens the subagent detail panel through the openProcessDetail facade", () => {
    // The descriptor routes through `openProcessDetail({ kind, id })`, which
    // delegates to `openSubagentDetail` — assert the resulting viewer state.
    SUBAGENT_DESCRIPTOR.onOpenDetail("sa-1");

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("subagent-detail");
    expect(state.activeSubagentId).toBe("sa-1");
  });
});

describe("SUBAGENT_DESCRIPTOR — useCardSummary projection", () => {
  test("returns null in the spawn-race window (no entry yet)", () => {
    const { result } = renderHook(() =>
      SUBAGENT_DESCRIPTOR.useCardSummary("missing"),
    );
    expect(result.current).toBeNull();
  });

  test("promotes the subagent label to the title; info falls back to the activity verb", () => {
    act(() => {
      seed("sa-1", "running", [], "Find tigers");
    });

    const { result } = renderHook(() =>
      SUBAGENT_DESCRIPTOR.useCardSummary("sa-1"),
    );

    // Title = the subagent's label (its task name), so labeled subagents read
    // distinctly. `currentStepInfo` for a no-step running entry is the label
    // itself, so the info line falls back to the activity verb ("Working")
    // rather than echoing the title — mirroring the bespoke card.
    expect(result.current).toEqual({
      state: "loading",
      title: "Find tigers",
      info: "Working",
      count: "0 steps",
    });
  });

  test("keeps the live activity on the info line when it differs from the label", () => {
    act(() => {
      seed("sa-2", "running", [
        {
          id: "te-0",
          type: "tool_call",
          content: "ls -la",
          toolName: "bash",
          toolUseId: "tu-1",
          timestamp: NOW,
        },
      ]);
    });

    const { result } = renderHook(() =>
      SUBAGENT_DESCRIPTOR.useCardSummary("sa-2"),
    );

    // Label ("Research Agent") is the title; the live tool activity ("ls -la")
    // differs from the label so it stays on the info line.
    expect(result.current).toEqual({
      state: "loading",
      title: "Research Agent",
      info: "ls -la",
      count: "1 step",
    });
  });

  test("projects a terminal (completed) subagent → complete state", () => {
    act(() => {
      seed(
        "sa-3",
        "completed",
        [{ id: "te-0", type: "text", content: "Done.", timestamp: NOW }],
        "Wrap up",
      );
    });

    const { result } = renderHook(() =>
      SUBAGENT_DESCRIPTOR.useCardSummary("sa-3"),
    );

    expect(result.current).toEqual({
      state: "complete",
      title: "Wrap up",
      info: "Done.",
      count: "1 step",
    });
  });
});
