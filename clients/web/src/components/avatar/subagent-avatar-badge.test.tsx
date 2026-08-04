/**
 * Tests for `SubagentAvatarBadge`.
 *
 * Drives the Zustand subagent store (spawn + changeStatus) and asserts the
 * glyph in the pill's fixed slot reflects the subagent's real status: running
 * dots while in-flight, a check on `completed`, and a red X on `aborted`
 * (canceled) / `failed`. Confirms the deterministic avatar chip renders, that
 * state is exposed via `data-status` (not colour alone), and that the slot
 * keeps the pill a constant width across every state.
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

/** Which glyph the indicator rendered, independent of its Tailwind classes. */
function renderedGlyph(indicator: Element): string | null {
  return (
    indicator.querySelector("[data-glyph]")?.getAttribute("data-glyph") ?? null
  );
}

describe("SubagentAvatarBadge", () => {
  test("renders the deterministic avatar chip", () => {
    spawn("sa-avatar", "running");
    const { container } = render(
      <SubagentAvatarBadge subagentId="sa-avatar" />,
    );
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
    expect(renderedGlyph(indicator)).toBe("dots");
    // Three pulsing dots use the shared busy-indicator class.
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(3);
  });

  test("completed → check glyph, no dots", () => {
    spawn("sa-done", "completed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-done" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("completed");
    expect(indicator.getAttribute("aria-label")).toBe("completed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(renderedGlyph(indicator)).toBe("check");
  });

  test("aborted → red X with data-status=aborted", () => {
    spawn("sa-aborted", "aborted");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-aborted" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("aborted");
    // Canceled reads distinctly from failed for assistive tech.
    expect(indicator.getAttribute("aria-label")).toBe("canceled");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(renderedGlyph(indicator)).toBe("cross");
  });

  test("failed → red X with data-status=failed", () => {
    spawn("sa-failed", "failed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-failed" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("failed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(renderedGlyph(indicator)).toBe("cross");
  });

  test("in-flight swaps background to --surface-active on hover, terminal tints do not", () => {
    spawn("sa-hover", "running");
    spawn("sa-hover-done", "completed");
    const { container } = render(
      <>
        <SubagentAvatarBadge subagentId="sa-hover" />
        <SubagentAvatarBadge subagentId="sa-hover-done" />
      </>,
    );
    const [pill, settledPill] = Array.from(
      container.querySelectorAll('[data-testid="subagent-avatar-badge"]'),
    );

    // The whole in-flight hover state is a background swap.
    expect(pill?.className).toContain("bg-[var(--surface-lift)]");
    expect(pill?.className).toContain("hover:bg-[var(--surface-active)]");

    expect(settledPill?.className).toContain(
      "bg-[var(--system-positive-weak)]",
    );
    // A settled pill is not interactive, so it carries no hover variant.
    expect(settledPill?.className).not.toContain("hover:");
  });

  test("errored tints the pill with the negative weak fill", () => {
    spawn("sa-tint-failed", "failed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-tint-failed" />,
    );
    expect(getByTestId("subagent-avatar-badge").className).toContain(
      "bg-[var(--system-negative-weak)]",
    );
  });

  test("renders no status indicator before the entry lands in the store", () => {
    const { queryByTestId } = render(
      <SubagentAvatarBadge subagentId="missing" />,
    );
    expect(queryByTestId("subagent-avatar-badge-status")).toBeNull();
    // The pill wrapper still renders.
    expect(queryByTestId("subagent-avatar-badge")).not.toBeNull();
  });

  test("the fixed glyph slot renders in every state so the pill never resizes", () => {
    const cases: Array<{ id: string; status?: SubagentStatus }> = [
      { id: "sa-slot-running", status: "running" },
      { id: "sa-slot-completed", status: "completed" },
      { id: "sa-slot-failed", status: "failed" },
      // Spawn race: no store entry yet.
      { id: "sa-slot-missing" },
    ];

    for (const { id, status } of cases) {
      if (status) {
        spawn(id, status);
      }
      const { container } = render(<SubagentAvatarBadge subagentId={id} />);
      const pill = container.querySelector(
        '[data-testid="subagent-avatar-badge"]',
      );
      const slot = container.querySelector(
        '[data-testid="subagent-avatar-badge-slot"]',
      );
      // happy-dom cannot measure layout, so the fixed widths are the only
      // available proof that the pill stays 46px wide in every state.
      expect(pill?.className).toContain("w-[46px]");
      expect(slot?.className).toContain("w-3.5");
    }
  });
});
