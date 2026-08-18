import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { CompanionSurface } from "./companion-surface";

afterEach(cleanup);

/**
 * The working ring: the surface's answer to "is it doing anything", drawn so it
 * can be read without reading. The class is the contract with `index.css`,
 * which is where the travel and the reduced-motion fallback live.
 */
const ringOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-working-ring");

describe("the companion surface's working ring", () => {
  test("is absent while nothing is running", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    expect(ringOf(container)).toBeNull();
  });

  test("is drawn at rest, which is the state it exists for", () => {
    const { container } = render(<CompanionSurface phase="resting" working />);
    expect(ringOf(container)).not.toBeNull();
  });

  test("is drawn on the expanded pill too", () => {
    const { container } = render(<CompanionSurface phase="hover" working />);
    expect(ringOf(container)).not.toBeNull();
  });

  test("follows the card's corner radius while typing", () => {
    const { container } = render(<CompanionSurface phase="typing" working />);
    expect(ringOf(container)?.className).toContain("rounded-[24px]");
  });

  test("is round in every state that is not the card", () => {
    const { container } = render(<CompanionSurface phase="hover" working />);
    expect(ringOf(container)?.className).toContain("rounded-full");
  });

  test("takes the assistant's own colour", () => {
    const { container } = render(
      <CompanionSurface phase="resting" working accentHex="#ff8800" />,
    );
    expect(ringOf(container)?.style.getPropertyValue("--companion-ring-accent"))
      .toBe("#ff8800");
  });

  /**
   * The surface is a click-through canvas that goes interactive only where the
   * pill is. A ring inset past the pill's own box must not be part of what the
   * pointer can hit, or it would widen the surface's hit area by its own margin.
   */
  test("is inert to the pointer", () => {
    const { container } = render(<CompanionSurface phase="resting" working />);
    expect(ringOf(container)?.className).toContain("pointer-events-none");
  });

  test("is hidden from assistive technology", () => {
    const { container } = render(<CompanionSurface phase="resting" working />);
    expect(ringOf(container)?.getAttribute("aria-hidden")).toBe("true");
  });

  /**
   * A spoken turn and a typed one are the same fact about the assistant, so the
   * call's own phase lights the same ring rather than a second treatment.
   */
  test("lights for a call's assistant turn without a published flag", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={{
          phase: "thinking",
          label: "Thinking",
          accentHex: "#5eead4",
          muted: false,
          outputMuted: false,
          detail: "",
          approvalRequestId: "",
          assistantName: "Ziggy",
          startedAt: 0,
        }}
      />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  test("stays dark while a call is waiting on the user", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={{
          phase: "listening",
          label: "Listening",
          accentHex: "#5eead4",
          muted: false,
          outputMuted: false,
          detail: "",
          approvalRequestId: "",
          assistantName: "Ziggy",
          startedAt: 0,
        }}
      />,
    );
    expect(ringOf(container)).toBeNull();
  });
});
