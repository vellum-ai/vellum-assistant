/**
 * Tests for `VoiceRoomEyes`.
 *
 * The blink and the cursor parallax are decorative, so they drive the DOM
 * through refs instead of React state (see `docs/CONVENTIONS.md`, "Keep
 * decorative animation out of the commit stream"). These tests pin that
 * property down from the outside: pointer movement and blink ticks change the
 * rendered transforms without producing a React render, and every blink
 * reopens.
 *
 * Both assertions carry more weight than render cost. A `setState` on either
 * path counts toward React's nested-update limit, and a throw from the blink
 * timer would strand the lids shut for the life of the room. See LUM-2927.
 */

import { useEffect } from "react";

import { afterEach, describe, expect, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import {
  VoiceRoomEyes,
  type VoiceRoomEyeArt,
} from "@/domains/chat/voice/voice-room/voice-room-eyes";

const ART: VoiceRoomEyeArt = {
  paths: [{ svgPath: "M0 0 H10 V10 H0 Z", color: "#000000" }],
  bbox: { x: 0, y: 0, w: 10, h: 10 },
};

const VIEWPORT = { w: 1000, h: 800 };

function renderEyes(onRender?: () => void) {
  function Probe() {
    useEffect(() => {
      onRender?.();
    });
    return <VoiceRoomEyes art={ART} viewport={VIEWPORT} />;
  }
  const utils = render(<Probe />);
  const root = utils.getByTestId("voice-room-eyes");
  // The lid group carries the blink transform; the parallax layer carries the
  // cursor offset. Addressed by test id rather than by tree position: the eyes
  // stack several transform layers that compose rather than replace each other
  // (parallax, the audio reaction, the per-state size tween), and `svg`'s
  // parent silently became a different one of them when the reaction layer
  // landed.
  const lids = root.querySelector("g") as SVGGElement;
  const parallax = utils.getByTestId("voice-room-eyes-parallax");
  return { ...utils, lids, parallax };
}

afterEach(() => {
  cleanup();
});

describe("VoiceRoomEyes: parallax stays out of the commit stream", () => {
  test("pointer movement moves the eyes without a React render", () => {
    let renders = 0;
    const { parallax } = renderEyes(() => {
      renders += 1;
    });
    const before = renders;

    act(() => {
      fireEvent.mouseMove(window, { clientX: 1000, clientY: 800 });
    });

    expect(parallax.style.transform).not.toBe("translate(0px, 0px)");
    expect(renders).toBe(before);
  });

  test("the offset tracks the pointer's position in the window", () => {
    const { parallax } = renderEyes();

    // Dead center maps to a zero offset.
    act(() => {
      fireEvent.mouseMove(window, {
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2,
      });
    });
    expect(parallax.style.transform).toBe("translate(0px, 0px)");

    // The far corner maps to the full excursion (CURSOR_MAX_X/Y).
    act(() => {
      fireEvent.mouseMove(window, {
        clientX: window.innerWidth,
        clientY: window.innerHeight,
      });
    });
    expect(parallax.style.transform).toBe("translate(4px, 3px)");
  });
});

describe("VoiceRoomEyes: blink stays out of the commit stream", () => {
  test("a click blinks the lids shut and reopens them, with no React render", async () => {
    let renders = 0;
    const { lids, parallax } = renderEyes(() => {
      renders += 1;
    });
    const before = renders;

    act(() => {
      fireEvent.click(parallax);
    });
    expect(lids.style.transform).toBe("scaleY(0.1)");
    expect(renders).toBe(before);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(lids.style.transform).toBe("scaleY(1)");
    expect(renders).toBe(before);
  });

  test("rapid clicks still reopen the lids", async () => {
    const { lids, parallax } = renderEyes();

    // Each click supersedes the pending reopen, so the last one has to win:
    // dropping a reopen is what leaves the eyes squinting for the session.
    act(() => {
      fireEvent.click(parallax);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    act(() => {
      fireEvent.click(parallax);
    });
    expect(lids.style.transform).toBe("scaleY(0.1)");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(lids.style.transform).toBe("scaleY(1)");
  });
});
