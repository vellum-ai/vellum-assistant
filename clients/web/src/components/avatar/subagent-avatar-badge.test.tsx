/**
 * Tests for `SubagentAvatarBadge`.
 *
 * Drives the Zustand subagent store (spawn + changeStatus) and asserts the
 * under-avatar indicator reflects the subagent's real status: running dots
 * while in-flight, a green check on `completed`, and a red ! on `aborted`
 * (canceled) / `failed`. Confirms the deterministic avatar chip renders and
 * that state is exposed via `data-status` (not colour alone).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

const NOW = 1700000000000;

beforeEach(() => {
  useSubagentStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

function spawn(id: string, status: SubagentStatus) {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label: "Research Agent",
    objective: "Find the answer",
    timestamp: NOW,
  });
  useSubagentStore.getState().changeStatus({ subagentId: id, status });
}

describe("SubagentAvatarBadge", () => {
  test("renders the deterministic avatar chip", () => {
    spawn("sa-avatar", "running");
    const { container } = render(<SubagentAvatarBadge subagentId="sa-avatar" />);
    expect(
      container.querySelector('[aria-label="Subagent sa-avatar"]'),
    ).not.toBeNull();
  });

  test("running → running dots indicator with data-status=running", () => {
    spawn("sa-running", "running");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-running" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("running");
    expect(indicator.getAttribute("aria-label")).toBe("running");
    // `role="img"` exposes the aria-label as a stable accessible name.
    expect(indicator.getAttribute("role")).toBe("img");
    // Three pulsing dots use the shared busy-indicator class.
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(3);
  });

  test("completed → green check, no dots", () => {
    spawn("sa-done", "completed");
    const { getByTestId } = render(<SubagentAvatarBadge subagentId="sa-done" />);
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("completed");
    expect(indicator.getAttribute("aria-label")).toBe("completed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(
      indicator.querySelector(".text-\\[var\\(--system-positive-strong\\)\\]"),
    ).not.toBeNull();
  });

  test("aborted → red ! with data-status=aborted", () => {
    spawn("sa-aborted", "aborted");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-aborted" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("aborted");
    // Canceled reads distinctly from failed for assistive tech.
    expect(indicator.getAttribute("aria-label")).toBe("canceled");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(
      indicator.querySelector(".text-\\[var\\(--system-negative-strong\\)\\]"),
    ).not.toBeNull();
  });

  test("failed → red ! with data-status=failed", () => {
    spawn("sa-failed", "failed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-failed" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("failed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(
      indicator.querySelector(".text-\\[var\\(--system-negative-strong\\)\\]"),
    ).not.toBeNull();
  });

  test("the circle swaps background to --surface-active on hover (per Figma)", () => {
    spawn("sa-hover", "running");
    const { getByTestId } = render(<SubagentAvatarBadge subagentId="sa-hover" />);
    const circle = getByTestId("subagent-avatar-badge");
    // The whole hover state is a background swap: --surface-lift → --surface-active.
    expect(circle.className).toContain("bg-[var(--surface-lift)]");
    expect(circle.className).toContain("hover:bg-[var(--surface-active)]");
  });

  test("renders no status indicator before the entry lands in the store", () => {
    const { queryByTestId } = render(
      <SubagentAvatarBadge subagentId="missing" />,
    );
    expect(queryByTestId("subagent-avatar-badge-status")).toBeNull();
    // The circle wrapper still renders.
    expect(queryByTestId("subagent-avatar-badge")).not.toBeNull();
  });
});
