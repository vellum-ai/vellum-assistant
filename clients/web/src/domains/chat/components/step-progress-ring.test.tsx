/**
 * The ring draws the plan's position as an arc, so the fraction it fills has to
 * track the same numbers the panel's counter states.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { StepProgressRing } from "@/domains/chat/components/step-progress-ring";

afterEach(() => {
  cleanup();
});

/** The arc is the second circle; the first is its track. */
function arc(container: HTMLElement): SVGCircleElement | undefined {
  return container.querySelectorAll<SVGCircleElement>("circle")[1];
}

function offsetFraction(el: SVGCircleElement): number {
  const dash = Number(el.getAttribute("stroke-dasharray"));
  const offset = Number(el.getAttribute("stroke-dashoffset"));
  // The visible run is the circumference less the offset.
  return (dash - offset) / dash;
}

describe("StepProgressRing", () => {
  test("fills the fraction of steps reached", () => {
    const { container } = render(<StepProgressRing current={3} total={4} />);
    expect(offsetFraction(arc(container)!)).toBeCloseTo(0.75, 5);
  });

  test("a complete plan closes the ring", () => {
    const { container } = render(<StepProgressRing current={4} total={4} />);
    expect(offsetFraction(arc(container)!)).toBeCloseTo(1, 5);
  });

  test("draws the bare track when there are no steps to count", () => {
    const { container } = render(<StepProgressRing current={0} total={0} />);
    // Track only: an arc of zero length would still paint a round cap.
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  test("clamps a count past the total rather than overdrawing", () => {
    // A plan whose counter runs ahead of its step list must not wrap the arc
    // back around the ring.
    const { container } = render(<StepProgressRing current={9} total={4} />);
    expect(offsetFraction(arc(container)!)).toBeCloseTo(1, 5);
  });
});
