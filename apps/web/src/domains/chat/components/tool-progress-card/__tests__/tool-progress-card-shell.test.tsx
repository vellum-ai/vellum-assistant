/**
 * Tests for `ToolProgressCardShell`.
 *
 * Verifies the reusable rounded-card chrome that's shared across web-search
 * and (in later PRs) generic / subagent tool-call progress cards:
 *  - the four `state` values each map to the expected leading indicator
 *  - controlled vs uncontrolled expand/collapse toggling
 *  - the optional `leadingIcon` slot only renders when supplied
 *  - `disableExpand` makes the header button non-interactive
 *  - terminal `state` transitions bypass the header-carousel dwell throttle
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { act, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";

afterEach(() => {
  cleanup();
});

function renderShell(
  overrides: Partial<
    React.ComponentProps<typeof ToolProgressCardShell>
  > = {},
) {
  return render(
    <ToolProgressCardShell
      state="loading"
      currentStepTitle="Doing the thing"
      currentStepInfo="extra info"
      stepCount="2 steps"
      {...overrides}
    >
      <div data-testid="shell-body">body content</div>
    </ToolProgressCardShell>,
  );
}

describe("ToolProgressCardShell — collapsed render per state", () => {
  test("loading renders the three-dot indicator", () => {
    const { getByTestId, container } = renderShell({ state: "loading" });
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName).toBe("SPAN");
    // No SVG icon present — the loading indicator is the dots, not a lucide
    // svg.
    expect(container.querySelector("svg")).toBeNull();
  });

  test("complete renders the CheckCircle2 icon", () => {
    const { getByTestId } = renderShell({ state: "complete" });
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("complete");
  });

  test("denied renders the alert icon tagged with data-state=denied", () => {
    const { getByTestId } = renderShell({ state: "denied" });
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("denied");
  });

  test("error renders the alert icon tagged with data-state=error", () => {
    const { getByTestId } = renderShell({ state: "error" });
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("error");
  });

  test("renders the title, info, and step count in the header", () => {
    const { getByText } = renderShell({
      currentStepTitle: "Searching",
      currentStepInfo: "for tigers",
      stepCount: "3 steps",
    });
    expect(getByText("Searching")).toBeTruthy();
    expect(getByText("for tigers")).toBeTruthy();
    expect(getByText("3 steps")).toBeTruthy();
  });

  test("does not render the children body when collapsed", () => {
    const { queryByTestId } = renderShell();
    expect(queryByTestId("shell-body")).toBeNull();
  });

  test("renders the children body when defaultExpanded", () => {
    const { getByTestId } = renderShell({ defaultExpanded: true });
    expect(getByTestId("shell-body")).toBeTruthy();
  });
});

describe("ToolProgressCardShell — expand/collapse", () => {
  test("uncontrolled: clicking the header expands the body and flips aria-expanded", () => {
    const { getByRole, queryByTestId, getByTestId } = renderShell();
    expect(queryByTestId("shell-body")).toBeNull();
    const button = getByRole("button", { name: /expand steps/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(getByTestId("shell-body")).toBeTruthy();
    expect(
      getByRole("button", { name: /collapse steps/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  test("controlled: external state drives expanded, onExpandChange fires on click", () => {
    const seen: boolean[] = [];
    function ControlledHarness() {
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <button
            type="button"
            data-testid="external-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            external
          </button>
          <ToolProgressCardShell
            state="loading"
            currentStepTitle="Title"
            currentStepInfo="info"
            stepCount="1 step"
            expanded={expanded}
            onExpandChange={(next) => {
              seen.push(next);
              setExpanded(next);
            }}
          >
            <div data-testid="shell-body">body</div>
          </ToolProgressCardShell>
        </>
      );
    }

    const { getByTestId, queryByTestId, getByRole } = render(
      <ControlledHarness />,
    );
    expect(queryByTestId("shell-body")).toBeNull();

    // External toggle expands — onExpandChange is NOT fired (parent flipped
    // its own state directly).
    fireEvent.click(getByTestId("external-toggle"));
    expect(getByTestId("shell-body")).toBeTruthy();
    expect(seen).toEqual([]);

    // Clicking the shell's own button fires onExpandChange with the next
    // value, which the parent harness applies.
    fireEvent.click(getByRole("button", { name: /collapse steps/i }));
    expect(seen).toEqual([false]);
    // aria-expanded flips back to false.
    expect(
      getByRole("button", { name: /expand steps/i }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
  });
});

describe("ToolProgressCardShell — leading icon slot", () => {
  test("renders the leadingIcon between the indicator and the title", () => {
    const { getByTestId, container } = renderShell({
      leadingIcon: <span data-testid="leading-icon">LI</span>,
    });
    expect(getByTestId("leading-icon")).toBeTruthy();
    // The icon sits inside the header label cluster, after the status
    // indicator. Sanity-check the indicator is also present.
    expect(getByTestId("tool-progress-card-status-indicator")).toBeTruthy();
    // The wrapper exists in the rendered DOM.
    expect(container.querySelector('[data-testid="leading-icon"]')).not.toBeNull();
  });

  test("omits the leading-icon wrapper when leadingIcon is undefined", () => {
    const { queryByTestId } = renderShell();
    expect(queryByTestId("leading-icon")).toBeNull();
  });
});

describe("ToolProgressCardShell — disableExpand", () => {
  test("the header button is disabled and does not toggle when disableExpand", () => {
    const { getByRole, queryByTestId } = renderShell({ disableExpand: true });
    const button = getByRole("button", { name: /expand steps/i });
    // The Button receives the disabled HTML attribute.
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    // Body remains hidden.
    expect(queryByTestId("shell-body")).toBeNull();
  });
});

describe("ToolProgressCardShell — headerActionSlot", () => {
  test("renders the headerActionSlot when provided", () => {
    const { getByTestId } = renderShell({
      headerActionSlot: (
        <button data-testid="action-button" type="button">
          stop
        </button>
      ),
    });
    expect(getByTestId("tool-progress-card-action-slot")).toBeTruthy();
    expect(getByTestId("action-button")).toBeTruthy();
  });

  test("omits the action slot when headerActionSlot is undefined", () => {
    const { queryByTestId } = renderShell();
    expect(queryByTestId("tool-progress-card-action-slot")).toBeNull();
  });

  test("action-slot children are NOT nested inside the toggle button", () => {
    // Regression guard for the nested-<button> HTML invalidity. The action
    // slot must render as a sibling of the toggle Button, not a descendant.
    const { getByTestId, getByRole } = renderShell({
      headerActionSlot: (
        <button data-testid="action-button" type="button">
          stop
        </button>
      ),
    });
    const toggle = getByRole("button", { name: /expand steps/i });
    const actionButton = getByTestId("action-button");
    expect(toggle.contains(actionButton)).toBe(false);
  });
});

describe("ToolProgressCardShell — props interface export", () => {
  test("ToolProgressCardState union enumerates the four supported states", () => {
    // Compile-time check: the union is `loading | complete | denied | error`.
    const allStates: ToolProgressCardState[] = [
      "loading",
      "complete",
      "denied",
      "error",
    ];
    expect(allStates).toHaveLength(4);
  });
});

// Terminal-state header bypass — the shell forwards `bypassDwell` whenever
// `state !== "loading"` so the final `(title, info)` lands in sync with
// the status-icon swap instead of trailing the 400ms throttle. We
// monkey-patch `setTimeout` / `Date.now` to drive virtual time (same
// pattern as `web-search-progress-card.test`).

interface TimerHandle {
  id: number;
  fn: () => void;
  fireAt: number;
  cleared: boolean;
  fired: boolean;
}

describe("ToolProgressCardShell — terminal-state header bypass", () => {
  let timers: TimerHandle[] = [];
  let nextTimerId = 1;
  let now = 1_000_000;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    timers = [];
    nextTimerId = 1;
    now = 1_000_000;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalDateNow = Date.now;
    Date.now = () => now;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      const handle: TimerHandle = {
        id: nextTimerId++,
        fn: () => fn(),
        fireAt: now + (ms ?? 0),
        cleared: false,
        fired: false,
      };
      timers.push(handle);
      return handle.id as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      const handle = timers.find((h) => h.id === id);
      if (handle) handle.cleared = true;
    }) as typeof globalThis.clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
    cleanup();
  });

  function advanceTime(ms: number) {
    now += ms;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = timers.filter(
        (h) => !h.cleared && !h.fired && h.fireAt <= now,
      );
      for (const handle of due) {
        handle.fired = true;
        progressed = true;
        act(() => {
          handle.fn();
        });
      }
    }
  }

  test("loading → complete transition lands the final title + info immediately", () => {
    const { getByText, rerender } = renderShell({
      state: "loading",
      currentStepTitle: "Searching the web",
      currentStepInfo: "for tigers",
    });
    expect(getByText("Searching the web")).toBeTruthy();
    expect(getByText("for tigers")).toBeTruthy();

    // Transition: state flips to `complete` AND the final header content
    // arrives in the same render. The bypass should flush the throttle so
    // both pieces appear immediately, in sync with the green check icon.
    rerender(
      <ToolProgressCardShell
        state="complete"
        currentStepTitle="Searched the web"
        currentStepInfo="2 sources"
        stepCount="2 steps"
      >
        <div data-testid="shell-body">body content</div>
      </ToolProgressCardShell>,
    );

    // The bypass commits via a `setDisplayed` call inside `useEffect`;
    // `advanceTime(0)` lets the queued microtask flush.
    advanceTime(0);

    // The new title + info appear without waiting for the 400ms dwell. The
    // exiting motion node may still hang around mid-animation (popLayout),
    // so we only assert the new content is mounted. The cleared-throttle
    // assertion below catches the regression directly.
    expect(getByText("Searched the web")).toBeTruthy();
    expect(getByText("2 sources")).toBeTruthy();
    // No live throttle timer should remain — bypass cancels any prior
    // dwell and never schedules a new one. (Without the bypass, the dwell
    // would queue a setTimeout here that we'd see in the queue.)
    expect(timers.filter((h) => !h.cleared && !h.fired)).toEqual([]);
  });

  test("loading → denied transition lands the final title + info immediately", () => {
    const { getByText, rerender } = renderShell({
      state: "loading",
      currentStepTitle: "Requesting access",
      currentStepInfo: "to calendar",
    });

    rerender(
      <ToolProgressCardShell
        state="denied"
        currentStepTitle="Access denied"
        currentStepInfo=""
        stepCount="1 step"
      >
        <div data-testid="shell-body">body content</div>
      </ToolProgressCardShell>,
    );
    advanceTime(0);

    expect(getByText("Access denied")).toBeTruthy();
    expect(timers.filter((h) => !h.cleared && !h.fired)).toEqual([]);
  });

  test("loading → error transition lands the final title + info immediately", () => {
    const { getByText, rerender } = renderShell({
      state: "loading",
      currentStepTitle: "Calling tool",
      currentStepInfo: "in progress",
    });

    rerender(
      <ToolProgressCardShell
        state="error"
        currentStepTitle="Tool failed"
        currentStepInfo="rate limited"
        stepCount="1 step"
      >
        <div data-testid="shell-body">body content</div>
      </ToolProgressCardShell>,
    );
    advanceTime(0);

    expect(getByText("Tool failed")).toBeTruthy();
    expect(getByText("rate limited")).toBeTruthy();
    expect(timers.filter((h) => !h.cleared && !h.fired)).toEqual([]);
  });

  test("loading → loading transitions still respect the 400ms throttle", () => {
    // Regression guard: the bypass must NOT trigger on plain loading-state
    // updates. Rapid loading-state metadata changes still need to coalesce.
    const { getByText, queryByText, rerender } = renderShell({
      state: "loading",
      currentStepTitle: "A",
      currentStepInfo: "alpha",
    });

    rerender(
      <ToolProgressCardShell
        state="loading"
        currentStepTitle="B"
        currentStepInfo="beta"
        stepCount="2 steps"
      >
        <div data-testid="shell-body">body content</div>
      </ToolProgressCardShell>,
    );

    // Throttle holds the previous value on-screen until the dwell elapses.
    expect(getByText("A")).toBeTruthy();
    expect(queryByText("B")).toBeNull();

    advanceTime(400);
    expect(getByText("B")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
  });
});
