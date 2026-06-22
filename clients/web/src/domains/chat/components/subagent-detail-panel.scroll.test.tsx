/**
 * The detail panel virtualizes its timeline against the panel body as an
 * *external* scroll element. TanStack Virtual registers its scroll listener
 * from a layout effect that runs child-first — before this parent div's ref
 * attaches — so the scroll element must be handed off via a state-backed
 * (callback) ref that re-renders on attach. With a plain `useRef`, a completed
 * subagent whose events arrive in one batch (no later re-render) never gets a
 * scroll listener and its timeline can't scroll past the first window.
 *
 * Unlike `subagent-detail-panel.test.tsx`, this file does NOT mock the timeline
 * — it needs the real virtualizer to observe the scroll element. Regression
 * guard for the unscrollable-completed-timeline bug.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <div data-testid="avatar" />,
}));

import { SubagentDetailPanel } from "@/domains/chat/components/subagent-detail-panel";
import { makeSyntheticEvents } from "@/domains/chat/components/__fixtures__/subagent-timeline-fixtures";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

function completedEntry(): SubagentEntry {
  return {
    subagentId: "sub-1",
    label: "Research agent",
    objective: "Do the thing",
    status: "completed",
    isFork: false,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    spawnedAt: 0,
    // Events already present in one batch, as for a completed/history subagent.
    events: makeSyntheticEvents(30),
  };
}

afterEach(() => {
  cleanup();
});

describe("SubagentDetailPanel — timeline scroll registration", () => {
  test("registers a scroll listener on the panel body for a completed subagent", () => {
    const scrollTargets = new Set<EventTarget>();
    const original = HTMLElement.prototype.addEventListener;
    HTMLElement.prototype.addEventListener = function (
      this: HTMLElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "scroll") scrollTargets.add(this);
      return original.call(this, type, listener, options);
    } as typeof HTMLElement.prototype.addEventListener;

    try {
      const { container } = render(
        <SubagentDetailPanel entry={completedEntry()} onClose={() => {}} />,
      );
      const scrollBody = container.querySelector(".overflow-y-auto");
      expect(scrollBody).not.toBeNull();
      // The virtualizer attaches a 'scroll' listener to its scroll element only
      // once the panel hands off the mounted node via the state-backed ref. A
      // plain ref would leave it unregistered (no re-render after the parent ref
      // attaches), so this assertion fails and the timeline is unscrollable.
      expect(scrollTargets.has(scrollBody as EventTarget)).toBe(true);
    } finally {
      HTMLElement.prototype.addEventListener = original;
    }
  });
});
