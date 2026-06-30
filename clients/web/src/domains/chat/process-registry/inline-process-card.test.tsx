/**
 * Tests for `InlineProcessCard` — the generic inline progress row shared by the
 * four background-process surfaces. A stub `summary` + `leadingIcon` exercise
 * the body without pulling in any store.
 *
 *  - Each of the five states renders the correct status icon (`data-state`).
 *  - The count is hidden for "0 …"/"1 …" rows and shown for "2 …".
 *  - `onOpen` fires on click + Enter; the leading cluster is inert (no
 *    role=button) when omitted.
 *  - The stop button is hidden without `onStop`; clicking it calls `onStop` and
 *    NOT `onOpen` (stopPropagation).
 *  - `testId`, `openAriaLabel`, and `stopAriaLabel` are emitted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { InlineProcessCard } from "@/domains/chat/process-registry/inline-process-card";
import { INLINE_CARD_STATUS_TESTID } from "@/domains/chat/process-registry/inline-card-status-icon";
import type { CardSummary } from "@/domains/chat/process-registry/types";
import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";

afterEach(() => {
  cleanup();
});

function summary(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    state: "loading",
    title: "Some process",
    info: "doing something",
    ...overrides,
  };
}

const leadingIcon = <span data-testid="leading-icon" />;

describe("InlineProcessCard — status icon", () => {
  test("loading renders the three-dot indicator (no data-state)", () => {
    render(
      <InlineProcessCard
        summary={summary({ state: "loading" })}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(
      screen.getByTestId(INLINE_CARD_STATUS_TESTID).getAttribute("data-state"),
    ).toBeNull();
  });

  test.each<[ToolProgressCardState, string]>([
    ["complete", "complete"],
    ["warning", "warning"],
    ["denied", "denied"],
    ["error", "error"],
  ])("%s renders the %s status icon", (state, expected) => {
    render(
      <InlineProcessCard
        summary={summary({ state })}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(
      screen.getByTestId(INLINE_CARD_STATUS_TESTID).getAttribute("data-state"),
    ).toBe(expected);
  });
});

describe("InlineProcessCard — count", () => {
  test("hides the count for a 0-count row", () => {
    render(
      <InlineProcessCard
        summary={summary({ count: "0 agents" })}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.queryByTestId("inline-process-card-count")).toBeNull();
  });

  test("hides the count for a 1-count row", () => {
    render(
      <InlineProcessCard
        summary={summary({ count: "1 agent" })}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.queryByTestId("inline-process-card-count")).toBeNull();
  });

  test("shows the count for a 2-count row", () => {
    render(
      <InlineProcessCard
        summary={summary({ count: "2 agents" })}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.getByTestId("inline-process-card-count").textContent).toBe(
      "2 agents",
    );
  });

  test("hides the count when summary.count is unset", () => {
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.queryByTestId("inline-process-card-count")).toBeNull();
  });
});

describe("InlineProcessCard — open affordance", () => {
  test("fires onOpen on click", () => {
    let opens = 0;
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
        onOpen={() => {
          opens += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open thing/i }));
    expect(opens).toBe(1);
  });

  test("fires onOpen on Enter", () => {
    let opens = 0;
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
        onOpen={() => {
          opens += 1;
        }}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /open thing/i }), {
      key: "Enter",
    });
    expect(opens).toBe(1);
  });

  test("has no role=button (inert) when onOpen is omitted", () => {
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.queryByRole("button", { name: /open thing/i })).toBeNull();
  });
});

describe("InlineProcessCard — stop button", () => {
  test("is hidden when onStop is omitted", () => {
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
      />,
    );
    expect(screen.queryByTestId("inline-process-card-stop")).toBeNull();
  });

  test("is hidden for a terminal summary even when onStop is supplied", () => {
    // Parity with the four existing inline cards, which gate the stop control
    // on the running (loading) state; terminal rows must not surface a stale
    // destructive action that dispatches an unnecessary cancellation.
    for (const state of ["complete", "warning", "denied", "error"] as const) {
      const { unmount } = render(
        <InlineProcessCard
          summary={summary({ state })}
          leadingIcon={leadingIcon}
          openAriaLabel="Open thing"
          onStop={() => {}}
        />,
      );
      expect(screen.queryByTestId("inline-process-card-stop")).toBeNull();
      unmount();
    }
  });

  test("clicking stop calls onStop and NOT onOpen (stopPropagation)", () => {
    let opens = 0;
    let stops = 0;
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
        onOpen={() => {
          opens += 1;
        }}
        onStop={() => {
          stops += 1;
        }}
        stopAriaLabel="Stop thing"
      />,
    );
    fireEvent.click(screen.getByTestId("inline-process-card-stop"));
    expect(stops).toBe(1);
    expect(opens).toBe(0);
  });

  test("defaults the stop aria-label to 'Stop' and honours an override", () => {
    const { rerender } = render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
        onStop={() => {}}
      />,
    );
    expect(
      screen.getByTestId("inline-process-card-stop").getAttribute("aria-label"),
    ).toBe("Stop");

    rerender(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open thing"
        onStop={() => {}}
        stopAriaLabel="Stop thing"
      />,
    );
    expect(
      screen.getByTestId("inline-process-card-stop").getAttribute("aria-label"),
    ).toBe("Stop thing");
  });
});

describe("InlineProcessCard — testid & aria", () => {
  test("emits the root testId and the openAriaLabel", () => {
    render(
      <InlineProcessCard
        summary={summary()}
        leadingIcon={leadingIcon}
        openAriaLabel="Open workflow"
        onOpen={() => {}}
        testId="my-inline-card"
      />,
    );
    expect(screen.getByTestId("my-inline-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open workflow/i })).toBeTruthy();
  });
});
