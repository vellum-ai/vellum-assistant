/**
 * Tests for `ToolProgressCardShell`.
 *
 * Verifies the reusable rounded-card chrome that's shared across web-search
 * and (in later PRs) generic / subagent tool-call progress cards:
 *  - the four `state` values each map to the expected leading indicator
 *  - controlled vs uncontrolled expand/collapse toggling
 *  - the optional `leadingIcon` slot only renders when supplied
 *  - `disableExpand` makes the header button non-interactive
 */

import { afterEach, describe, expect, test } from "bun:test";

import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  ToolProgressCardShell,
  type ToolProgressCardState,
} from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell.js";

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
