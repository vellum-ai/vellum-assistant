/**
 * Tests for `ChannelSetupWizard`, the chrome shared by the channel setup
 * wizards:
 *
 *   1. A step change moves focus to the panel. Without this, swapping the
 *      panel's contents takes the focused control with it and drops focus to
 *      `<body>`, so a keyboard user tabs from the top of the page on every
 *      step and a screen reader is told nothing.
 *   2. The first render does not steal focus.
 *   3. The panel is labelled with the step it holds, so the move announces
 *      something useful rather than an unnamed group.
 *   4. The stepper returns to finished steps and refuses to skip ahead.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";

import { ChannelSetupWizard } from "@/components/channel-setup-wizard";

const STEPS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];

function Harness({ locked = false }: { locked?: boolean }) {
  const [stepIndex, setStepIndex] = useState(0);
  return (
    <ChannelSetupWizard
      channelLabel="Slack"
      steps={STEPS}
      stepIndex={stepIndex}
      onStepSelect={(i) => {
        if (i < stepIndex) {
          setStepIndex(i);
        }
      }}
      locked={locked}
    >
      <button type="button" onClick={() => setStepIndex(stepIndex + 1)}>
        Advance from {STEPS[stepIndex].label}
      </button>
    </ChannelSetupWizard>
  );
}

const panel = () => {
  const el = document.querySelector('[data-slot="channel-setup-step-panel"]');
  if (!el) {
    throw new Error("step panel did not render");
  }
  return el as HTMLElement;
};

afterEach(cleanup);

describe("ChannelSetupWizard", () => {
  test("does not steal focus on first render", () => {
    render(<Harness />);

    expect(document.activeElement).not.toBe(panel());
    expect(document.activeElement).toBe(document.body);
  });

  test("does not steal focus on first render under StrictMode", () => {
    // The app mounts under StrictMode (`main.tsx`), which runs effects, cleans
    // up, and runs them again. A "have I rendered before" flag flips on that
    // second pass and then reads as a real step change, so development builds
    // pulled focus into the drawer the moment it opened. The plain render
    // above cannot catch that: it only runs the effect once.
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    expect(document.activeElement).toBe(document.body);
  });

  test("moves focus to the panel when the step changes", () => {
    render(<Harness />);

    const advance = screen.getByRole("button", { name: /Advance from One/i });
    advance.focus();
    expect(document.activeElement).toBe(advance);

    fireEvent.click(advance);

    // The clicked control unmounted with the old step. Focus must land on the
    // panel rather than falling back to <body>.
    expect(document.activeElement).toBe(panel());
    expect(document.activeElement).not.toBe(document.body);
  });

  test("labels the panel with the step it holds", () => {
    render(<Harness />);

    expect(panel().getAttribute("aria-label")).toBe(
      "Slack setup, step 1 of 3: One",
    );

    fireEvent.click(screen.getByRole("button", { name: /Advance from One/i }));

    expect(panel().getAttribute("aria-label")).toBe(
      "Slack setup, step 2 of 3: Two",
    );
  });

  test("the stepper returns to finished steps but will not skip ahead", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: /Advance from One/i }));
    fireEvent.click(screen.getByRole("button", { name: /Advance from Two/i }));
    expect(panel().getAttribute("aria-label")).toMatch(/step 3 of 3/);

    // Completed steps render as buttons; the active and upcoming ones do not,
    // so a forward jump has nothing to click in the first place.
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    expect(panel().getAttribute("aria-label")).toMatch(/step 1 of 3: One/);

    expect(screen.queryByRole("button", { name: "Three" })).toBeNull();
  });

  test("locking removes the stepper's back navigation", () => {
    render(<Harness locked />);

    fireEvent.click(screen.getByRole("button", { name: /Advance from One/i }));

    expect(screen.queryByRole("button", { name: "One" })).toBeNull();
  });
});
