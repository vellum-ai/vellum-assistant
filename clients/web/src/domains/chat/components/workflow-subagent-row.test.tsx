/**
 * Tests for `WorkflowSubagentRow`.
 *
 * Focuses on the lead indicator resolving differently per leaf status: the
 * three-dot pulse while running vs. a terminal status glyph (e.g. the green
 * check on `completed`). The glyph crossfades via `AnimatePresence`, but the
 * active glyph is present synchronously on mount, so a plain render suffices.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// Stub the avatar renderer so rows don't depend on the lazily-imported bundled
// SVG chunk. (Mock the renderer, not `useBundledAvatarComponents` — Bun module
// mocks are process-global and survive `mock.restore()`, so mocking the hook
// here would leak into other files' tests that rely on the real one.)
mock.module("@/components/avatar-renderer", () => ({
  AvatarRenderer: () => <div data-testid="avatar" />,
}));

import { WorkflowSubagentRow } from "@/domains/chat/components/workflow-subagent-row";
import type { WorkflowLeaf } from "@/domains/chat/workflow-store";

const noop = () => {};

function makeLeaf(
  overrides: Partial<WorkflowLeaf> & { seq: number },
): WorkflowLeaf {
  return {
    status: "running",
    label: "Research Agent",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("WorkflowSubagentRow", () => {
  test("running → three-dot pulse, no terminal glyph", () => {
    const { container } = render(
      <WorkflowSubagentRow
        runId="run-1"
        leaf={makeLeaf({ seq: 0, status: "running" })}
        components={null}
        onSelect={noop}
      />,
    );
    // The running leaf shows the shared three-dot busy indicator.
    expect(container.querySelectorAll(".busy-indicator").length).toBe(3);
    // No terminal SVG glyph (CircleCheck / TriangleAlert / Ban).
    expect(container.querySelector("svg")).toBeNull();
  });

  test("completed → terminal glyph, no three-dot pulse", () => {
    const { container } = render(
      <WorkflowSubagentRow
        runId="run-1"
        leaf={makeLeaf({ seq: 0, status: "completed" })}
        components={null}
        onSelect={noop}
      />,
    );
    // The terminal status renders a lucide SVG glyph instead of the dots.
    expect(container.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
