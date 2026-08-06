/**
 * Tests for `SubagentAvatarBadge`.
 *
 * Seeds the Zustand subagent store with one entry per case and asserts the
 * glyph in the pill's fixed slot reflects the subagent's real status: running
 * dots while in-flight, a check on `completed`, and a red X on `aborted`
 * (canceled) / `failed`. Confirms the deterministic avatar chip renders, that
 * state is exposed via `data-status` (not colour alone), that every status
 * lands in its expected tint bucket, and that the fixed slot renders in every
 * state so the avatar's horizontal position never moves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

const NOW = 1700000000000;

/**
 * Every status paired with the pill fill it must produce. Typed as a total
 * `Record<SubagentStatus, ...>` so adding a status to the wire schema fails to
 * compile until its tint bucket is declared here.
 */
const EXPECTED_PILL_BACKGROUND: Record<SubagentStatus, string> = {
  completed: "bg-[var(--system-positive-weak)]",
  failed: "bg-[var(--system-negative-weak)]",
  aborted: "bg-[var(--system-negative-weak)]",
  interrupted: "bg-[var(--system-negative-weak)]",
  running: "bg-[var(--surface-lift)]",
  pending: "bg-[var(--surface-lift)]",
  awaiting_input: "bg-[var(--surface-lift)]",
};

const TINT_CASES = Object.entries(EXPECTED_PILL_BACKGROUND) as Array<
  [SubagentStatus, string]
>;

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
    status,
  });
}

/** Which glyph the indicator rendered, independent of its Tailwind classes. */
function renderedGlyph(indicator: Element): string | null {
  return (
    indicator.querySelector("[data-glyph]")?.getAttribute("data-glyph") ?? null
  );
}

/** The class list on the glyph icon, where its colour token is applied. */
function glyphClasses(indicator: Element): string {
  return indicator.querySelector("svg")?.getAttribute("class") ?? "";
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

  test("completed → check glyph in the positive on-weak token, no dots", () => {
    spawn("sa-done", "completed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-done" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("completed");
    expect(indicator.getAttribute("aria-label")).toBe("completed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(renderedGlyph(indicator)).toBe("check");
    // The on-weak pairing is what clears contrast against the weak pill fill.
    expect(glyphClasses(indicator)).toContain(
      "text-[var(--system-positive-on-weak)]",
    );
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

  test("failed → X glyph in the negative on-weak token, data-status=failed", () => {
    spawn("sa-failed", "failed");
    const { getByTestId } = render(
      <SubagentAvatarBadge subagentId="sa-failed" />,
    );
    const indicator = getByTestId("subagent-avatar-badge-status");
    expect(indicator.getAttribute("data-status")).toBe("failed");
    expect(indicator.querySelectorAll(".busy-indicator").length).toBe(0);
    expect(renderedGlyph(indicator)).toBe("cross");
    expect(glyphClasses(indicator)).toContain(
      "text-[var(--system-negative-on-weak)]",
    );
  });

  for (const [status, expected] of TINT_CASES) {
    test(`${status} tints the pill with ${expected}`, () => {
      const id = `sa-tint-${status}`;
      spawn(id, status);
      const { getByTestId } = render(<SubagentAvatarBadge subagentId={id} />);
      expect(getByTestId("subagent-avatar-badge").className).toContain(
        expected,
      );
    });
  }

  test("the in-flight pill declares a hover fill and terminal tints declare none", () => {
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

    // `SubagentAvatarRow` renders the badges inside a `pointer-events-none`
    // wrapper, so the hover fill is inert there. This pins the class contract,
    // not an observable hover: a badge mounted outside that wrapper is the
    // case the fill exists for.
    expect(pill?.className).toContain("bg-[var(--surface-lift)]");
    expect(pill?.className).toContain("hover:bg-[var(--surface-active)]");

    expect(settledPill?.className).toContain(
      "bg-[var(--system-positive-weak)]",
    );
    // A settled pill can no longer change, so it carries no hover variant.
    expect(settledPill?.className).not.toContain("hover:");
  });

  test("renders no status indicator before the entry lands in the store", () => {
    const { queryByTestId } = render(
      <SubagentAvatarBadge subagentId="missing" />,
    );
    expect(queryByTestId("subagent-avatar-badge-status")).toBeNull();
    // The pill wrapper still renders.
    expect(queryByTestId("subagent-avatar-badge")).not.toBeNull();
  });

  test("the fixed glyph slot renders in every state so the avatar never shifts", () => {
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
      // The slot is what holds the avatar's horizontal position constant:
      // drop it in any one state and the narrower glyph pulls the avatar left.
      expect(
        container.querySelector('[data-testid="subagent-avatar-badge-slot"]'),
      ).not.toBeNull();
    }
  });
});
