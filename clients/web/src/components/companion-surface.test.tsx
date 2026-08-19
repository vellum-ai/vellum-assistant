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
    expect(
      ringOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff8800");
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
        }}
      />,
    );
    expect(ringOf(container)).toBeNull();
  });
});

/**
 * The avatar is the surface's drag handle, and it renders as one of two very
 * different things: a composed creature of SVG and divs, or a bare `<img>` for
 * a custom uploaded avatar. Only the image is natively draggable, so only the
 * image can hand the press to the platform's own HTML5 drag and starve the
 * surface of the `mousemove` stream its drag runs on.
 *
 * jsdom implements no native image drag, so what a test can hold is the opt
 * out itself rather than its effect: the attribute, and the WebKit-only CSS
 * that covers the paths where WebKit ignores the attribute.
 */
describe("the companion surface's custom avatar", () => {
  const imageOf = (container: HTMLElement): HTMLImageElement | null =>
    container.querySelector("img");

  test("renders for an assistant with no traits to compose", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarSrc="data:image/png;base64,AA" />,
    );
    expect(imageOf(container)?.getAttribute("src")).toBe(
      "data:image/png;base64,AA",
    );
  });

  test("refuses the browser's own image drag", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarSrc="data:image/png;base64,AA" />,
    );
    expect(imageOf(container)?.getAttribute("draggable")).toBe("false");
  });

  test("refuses it in WebKit, which reads the CSS and not the attribute", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarSrc="data:image/png;base64,AA" />,
    );
    expect(imageOf(container)?.className).toContain("[-webkit-user-drag:none]");
  });

  /**
   * The creature branch has no image at all, which is why the bug reached the
   * custom avatars alone.
   */
  test("is not what a composed creature renders", () => {
    const { container } = render(
      <CompanionSurface
        phase="resting"
        character={{ bodyShape: "blob", eyeStyle: "curious", color: "teal" }}
      />,
    );
    expect(imageOf(container)).toBeNull();
  });
});

/**
 * Where the avatar sits inside the canvas.
 *
 * The canvas is not symmetric about the avatar: the card's height is reserved
 * on whichever side it grows into, and only the avatar's own box and its shadow
 * on the other. So the surface anchors to the *near* edge, and `100%` names the
 * canvas without this side knowing how tall the host made it. That is what lets
 * main flip the direction near the top of a display without the renderer
 * learning the canvas's height (JARVIS-1548).
 */
describe("the companion surface's anchor in the canvas", () => {
  /** The pill itself, which is also the surface's drag handle. */
  const surfaceOf = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector<HTMLElement>(".cursor-grab");
    if (!found) {
      throw new Error("Expected the surface to render");
    }
    return found;
  };

  test("hangs off the canvas's bottom edge while the card grows up", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    expect(surfaceOf(container).style.top).toBe("calc(100% - 46px)");
  });

  test("sits against the canvas's top edge while the card grows down", () => {
    const { container } = render(
      <CompanionSurface phase="resting" cardGrowth="down" />,
    );
    expect(surfaceOf(container).style.top).toBe("46px");
  });

  test("grows up by default, which is where the surface normally lives", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    const { container: explicit } = render(
      <CompanionSurface phase="resting" cardGrowth="up" />,
    );
    expect(surfaceOf(container).style.top).toBe(surfaceOf(explicit).style.top);
  });

  /**
   * The avatar's line is the fixed point in both directions. Growing up, the
   * card's bottom row sits on it; growing down, its top row does. Either way
   * the mascot is where it was before Type was pressed.
   */
  test("hangs the card off the avatar's line when it grows up", () => {
    const { container } = render(<CompanionSurface phase="typing" />);
    expect(surfaceOf(container).style.transform).toBe(
      "translateY(calc(-100% + 22px))",
    );
  });

  test("drops the card from the avatar's line when it grows down", () => {
    const { container } = render(
      <CompanionSurface phase="typing" cardGrowth="down" />,
    );
    expect(surfaceOf(container).style.transform).toBe("translateY(-22px)");
  });

  /**
   * The column reverses for the reason the row does when the pill grows left:
   * the row holding the avatar's line has to end up against the avatar, and the
   * conversation stacks away from it.
   */
  test("reverses the card's column when it grows down", () => {
    const { container } = render(
      <CompanionSurface phase="typing" cardGrowth="down" />,
    );
    expect(surfaceOf(container).className).toContain("flex-col-reverse");
  });

  test("stacks the card upward in the ordinary direction", () => {
    const { container } = render(<CompanionSurface phase="typing" />);
    const className = surfaceOf(container).className;
    expect(className).toContain("flex-col");
    expect(className).not.toContain("flex-col-reverse");
  });

  /** The pill is centred on the avatar's line whichever way the card would go. */
  test("centres the resting pill on the avatar's line either way", () => {
    for (const cardGrowth of ["up", "down"] as const) {
      const { container } = render(
        <CompanionSurface phase="resting" cardGrowth={cardGrowth} />,
      );
      expect(surfaceOf(container).style.transform).toBe("translateY(-50%)");
      cleanup();
    }
  });
});
