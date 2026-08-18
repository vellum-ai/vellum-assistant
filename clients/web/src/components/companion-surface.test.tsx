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
