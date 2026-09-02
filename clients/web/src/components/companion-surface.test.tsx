import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as motionReact from "motion/react";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_MAX_PILL_WIDTH,
} from "@vellumai/ipc-contract";
import type { VoiceActivityState } from "@vellumai/ipc-contract";

/**
 * The reduced-motion answer, so one case can render the surface as a reader who
 * has asked for stillness sees it. Spread over the real module rather than
 * standing in for it, since the creature's own artwork animates through the
 * same package.
 */
let reducedMotion = false;

mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const { CompanionSurface, FALLBACK_WIDTHS, INNER_GAP } =
  await import("./companion-surface");

afterEach(() => {
  cleanup();
  reducedMotion = false;
});

/** The ordinary middle of a call: unmuted, listening, nothing to decide. */
const LISTENING_CALL: VoiceActivityState = {
  phase: "listening",
  label: "Listening",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

/** Every state the surface draws, which several cases here sweep in turn. */
const PHASES = ["resting", "hover", "watching", "summary", "call"] as const;

/**
 * The working ring: the surface's answer to "is it doing anything", drawn so it
 * can be read without reading. The class is the contract with `index.css`,
 * which is where the travel and the reduced-motion fallback live.
 */
const ringOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-working-ring");

/** The wrapper the idle bob runs on, which sits inside the avatar's box. */
const bobOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-avatar-bob");

describe("the companion surface's working ring", () => {
  test("is absent while nothing is running", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    expect(ringOf(container)).toBeNull();
  });

  test("is drawn at rest, which is the state it exists for", () => {
    const { container } = render(<CompanionSurface phase="resting" working />);
    expect(ringOf(container)).not.toBeNull();
  });

  test("is drawn with the pill open too", () => {
    const { container } = render(<CompanionSurface phase="hover" working />);
    expect(ringOf(container)).not.toBeNull();
  });

  /**
   * **The ring belongs to the creature.** The avatar is drawn in every phase
   * and holds one spot in the canvas, so the light stays where the eye already
   * looks for this surface's state. Handing it to the pill while expanded would
   * move it to a different parent every time the pointer crossed, which
   * remounts everything hanging off it.
   */
  test("hangs off the avatar in every phase", () => {
    for (const phase of PHASES) {
      const { container } = render(<CompanionSurface phase={phase} working />);
      expect(ringOf(container)?.closest(".size-11")).not.toBeNull();
      cleanup();
    }
  });

  /** Around the creature's own box, so it is a circle whatever the pill is. */
  test("stays round while the pill is open", () => {
    const { container } = render(<CompanionSurface phase="call" working />);
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

  /**
   * A session reading the screen lights the same ring, in a colour of its own.
   * The ring is the whole of what says a capture is running while the pointer
   * is elsewhere, so it is worth a test that it is lit and one that it is not
   * wearing the assistant's colour, which already means something else.
   */
  test("lights for a watch session", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  test("burns a watch session in the capture colour, not the assistant's", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching accentHex="#ff8800" />,
    );
    expect(
      ringOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  /**
   * The capture keeps the colour when a turn is running under it. The creature
   * carries the turn in its own pose, and a capture drawn in a colour that also
   * means "a reply is streaming" is one the user has no reason to read as a
   * capture.
   */
  test("keeps the capture colour while a turn runs under the session", () => {
    const { container } = render(
      <CompanionSurface
        phase="watching"
        watching
        working
        accentHex="#ff8800"
      />,
    );
    expect(
      ringOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  /**
   * The phase is what the pill is showing and the flag is what is running, so
   * the phase on its own is not a capture. This is the guard on that: an
   * indicator that read the phase would be lit here, and would be dark in the
   * two phases below that outrank it.
   */
  test("stays dark for the phase alone, which is not a running session", () => {
    const { container } = render(<CompanionSurface phase="watching" />);
    expect(ringOf(container)).toBeNull();
  });

  test("stays dark while a call is waiting on the user", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(ringOf(container)).toBeNull();
  });
});

/**
 * The capture pulse: one flare of the ring for each screen read a watch
 * session actually took.
 *
 * The ring says a session is open, which holds for minutes; this says the
 * screen was read just now, which is the thing the user wants confirmed. What
 * the cases here pin is that it is drawn for exactly the reads that happened:
 * it needs a running session and a count that stepped while the surface was
 * watching, and each step gets its own flare rather than one element that
 * lingers.
 */
describe("the companion surface's capture pulse", () => {
  const pulseOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>(".companion-capture-pulse");

  test("is drawn for a capture that landed while the surface was open", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="watching" watching captureCount={0} />,
    );

    rerender(<CompanionSurface phase="watching" watching captureCount={1} />);

    expect(pulseOf(container)).not.toBeNull();
  });

  test("is absent for a session that has captured nothing yet", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching captureCount={0} />,
    );
    expect(pulseOf(container)).toBeNull();
  });

  /**
   * The macOS renderer is recreated on a reload and the main process replays
   * its retained state into the new one, so a first render lands mid-session
   * with whatever the count had reached. Flaring on it would present a read
   * from a minute ago as one happening now, which is the same lie the whole
   * indicator was built to avoid: the first value is a baseline, not a step.
   */
  test("is absent on a mount that inherits a running session's count", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching captureCount={12} />,
    );
    expect(pulseOf(container)).toBeNull();
  });

  /**
   * The same reload, arriving the way it does through the window that owns the
   * state: this surface is drawn before the push lands, so the session and its
   * accumulated count turn up together one render later. The count came with
   * the session rather than moving under it, so there is no capture in it.
   */
  test("is absent when a session arrives already having captured", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="hover" captureCount={0} />,
    );

    rerender(<CompanionSurface phase="watching" watching captureCount={12} />);

    expect(pulseOf(container)).toBeNull();
  });

  /**
   * A count with no session behind it is the leftover total of a session that
   * has ended, and a flare drawn from it would claim a capture on a machine
   * nothing is reading.
   */
  test("is absent when no session is running", () => {
    const { container } = render(
      <CompanionSurface phase="hover" captureCount={4} />,
    );
    expect(pulseOf(container)).toBeNull();
  });

  /**
   * Each capture is its own event, so each gets its own element: the animation
   * is one-shot, and a node that survived the count changing would play once
   * for the first read of a session and never again.
   */
  test("replays for each capture rather than lingering from the first", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="watching" watching captureCount={0} />,
    );
    rerender(<CompanionSurface phase="watching" watching captureCount={1} />);
    const first = pulseOf(container);

    rerender(<CompanionSurface phase="watching" watching captureCount={2} />);

    expect(pulseOf(container)).not.toBeNull();
    expect(pulseOf(container)).not.toBe(first);
  });

  /**
   * The next session starts from a baseline of its own. Carrying the last
   * flare across the gap would replay it the moment the ring comes back on,
   * marking a capture the new session has not taken.
   */
  test("does not replay the previous session's last capture on the next one", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="watching" watching captureCount={0} />,
    );
    rerender(<CompanionSurface phase="watching" watching captureCount={1} />);
    rerender(<CompanionSurface phase="hover" captureCount={1} />);

    rerender(<CompanionSurface phase="watching" watching captureCount={0} />);

    expect(pulseOf(container)).toBeNull();
  });

  test("takes the capture colour, which is the session's and not the assistant's", () => {
    const { container, rerender } = render(
      <CompanionSurface
        phase="watching"
        watching
        captureCount={0}
        accentHex="#ff8800"
      />,
    );

    rerender(
      <CompanionSurface
        phase="watching"
        watching
        captureCount={1}
        accentHex="#ff8800"
      />,
    );

    expect(
      pulseOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  test("stays round while the pill is open", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="call" watching captureCount={0} />,
    );

    rerender(<CompanionSurface phase="call" watching captureCount={1} />);

    expect(pulseOf(container)?.className).toContain("rounded-full");
  });

  /**
   * The flare is one-shot, so a node unmounted and put back plays it again. The
   * pointer crosses this surface constantly while a session runs, and none of
   * those crossings is a screen being read: a flare drawn for one would be the
   * indicator claiming a capture that did not happen.
   */
  test("does not replay when the phase changes under a running session", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="resting" watching captureCount={0} />,
    );
    rerender(<CompanionSurface phase="resting" watching captureCount={1} />);
    const flare = pulseOf(container);
    expect(flare).not.toBeNull();

    rerender(<CompanionSurface phase="hover" watching captureCount={1} />);
    rerender(<CompanionSurface phase="resting" watching captureCount={1} />);

    expect(pulseOf(container)).toBe(flare);
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
 * Where the avatar sits inside the canvas, and where the pill hangs off it.
 *
 * The canvas is not symmetric about the avatar: the card's height is reserved
 * on whichever side it grows into, and only the avatar's own box and its shadow
 * on the other. So the surface anchors to the *near* edge, and `100%` names the
 * canvas without this side knowing how tall the host made it. That is what lets
 * main flip the direction near the top of a display without the renderer
 * learning the canvas's height (JARVIS-1548).
 */
/** The pill, which is the one element on the surface whose width animates. */
const surfaceOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>(".transition-\\[width\\]");
  if (!found) {
    throw new Error("Expected the surface to render");
  }
  return found;
};

/** The avatar's own box, which is the point the host positions the window by. */
const avatarOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>(".size-11");
  if (!found) {
    throw new Error("Expected the avatar to render");
  }
  return found;
};

/**
 * The shape drawn inside that box: the creature's whole box while the surface
 * is expanded, a thin capsule at rest. The box's first child, and the node the
 * working ring is drawn around, so the ring hugs whichever of the two it is.
 */
const shapeOf = (container: HTMLElement): HTMLElement => {
  const found = avatarOf(container).firstElementChild as HTMLElement | null;
  if (found === null) {
    throw new Error("Expected the avatar's shape to render");
  }
  return found;
};

/**
 * The capsule drawn at rest, which is a sibling of that box rather than a child
 * of it: it holds its own size while the ring's box grows to the creature's.
 */
const capsuleOf = (container: HTMLElement): HTMLElement => {
  const found = avatarOf(container).children[1] as HTMLElement | undefined;
  if (found === undefined) {
    throw new Error("Expected the resting capsule to render");
  }
  return found;
};

describe("the companion surface's anchor in the canvas", () => {
  test("grows up by default, which is where the surface normally lives", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    const { container: explicit } = render(
      <CompanionSurface phase="resting" cardGrowth="up" />,
    );
    expect(avatarOf(container).style.top).toBe(avatarOf(explicit).style.top);
  });

  /**
   * The creature's visible bottom is the fixed point. The pill's bottom sits on
   * it rather than on the avatar's box, which runs a further 8 points down to
   * hold the bob's slack, and the mascot never moves whichever way the pill or the
   * card grows.
   */
  test("sits the pill's bottom on the creature's visible bottom", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    // 54 from the canvas edge to the avatar's centre, 14 further to the bottom
    // of the 28pt artwork inside its 44pt box.
    expect(surfaceOf(container).style.top).toBe("calc(100% - 40px)");
    expect(surfaceOf(container).style.transform).toBe("translateY(-100%)");
  });

  /**
   * The pill's bottom is the avatar's bottom, and it hangs upward off that
   * line in the ordinary direction.
   */
  test("hangs the pill off the creature's line when the canvas grows up", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(surfaceOf(container).style.top).toBe("calc(100% - 40px)");
    expect(surfaceOf(container).style.transform).toBe("translateY(-100%)");
  });

  /**
   * Everything against the other edge: the avatar sits on the canvas's top
   * line, and the pill keeps its bottom on the creature's.
   */
  test("anchors everything against the canvas's top edge when the card grows down", () => {
    const { container: resting } = render(
      <CompanionSurface phase="resting" cardGrowth="down" />,
    );
    expect(avatarOf(resting).style.top).toBe("54px");

    const { container: hover } = render(
      <CompanionSurface phase="hover" cardGrowth="down" />,
    );
    expect(surfaceOf(hover).style.top).toBe("68px");
    expect(surfaceOf(hover).style.transform).toBe("translateY(-100%)");
  });

  /**
   * The two are siblings with a gap between them, which is what the host's
   * union hit-test is built on. A pill that contained the avatar would make a
   * bounding box the honest answer and take the gap's dead corners with it.
   */
  test("draws the avatar beside the pill rather than inside it", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(surfaceOf(container).contains(avatarOf(container))).toBe(false);
    expect(avatarOf(container).parentElement).toBe(
      surfaceOf(container).parentElement,
    );
  });

  /**
   * The property everything else here is in service of: the host positions the
   * window by the creature, so the creature has to sit on the same point in
   * every state the surface can be in.
   */
  test("keeps the avatar's own point in every phase", () => {
    for (const phase of PHASES) {
      const { container } = render(<CompanionSurface phase={phase} />);
      expect(avatarOf(container).style.left).toBe("50%");
      expect(avatarOf(container).style.top).toBe("calc(100% - 54px)");
      expect(avatarOf(container).style.transform).toBe("translate(-50%, -50%)");
      cleanup();
    }
  });

  test("keeps it whichever way the card would go", () => {
    for (const cardGrowth of ["up", "down"] as const) {
      const { container } = render(
        <CompanionSurface phase="resting" cardGrowth={cardGrowth} />,
      );
      expect(avatarOf(container).style.left).toBe("50%");
      expect(avatarOf(container).style.transform).toBe("translate(-50%, -50%)");
      cleanup();
    }
  });
});

/**
 * The surface with the creature and the controls sized apart.
 *
 * The surface's own outermost box is scaled by the options size, so everything
 * inside it is stated in the units the layout is authored in and the creature
 * carries the difference between the two boxes itself. What has to hold is that
 * the pill still sits a gap off the creature's *visual* edge and still shares
 * its bottom line, whichever of the two is the larger, because that edge and
 * that line are what the host places the window by.
 */
describe("the companion surface at two sizes", () => {
  /** The outermost element, which is where the options scale is spent. */
  const boxOf = (container: HTMLElement): HTMLElement => {
    const found = container.firstElementChild;
    if (!(found instanceof HTMLElement)) {
      throw new Error("Expected the surface's scaled box to render");
    }
    return found;
  };

  /**
   * The box is the canvas divided by the options scale and blown back up about
   * its top-left corner, so it covers the canvas exactly and every length
   * inside resolves in the units the layout is written in. The host is handed
   * one surface rather than a scale it has to apply itself.
   */
  test("scales its own box by the options size rather than the creature's", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarBox={44} optionsBox={110} />,
    );
    const box = boxOf(container);
    expect(box.style.transform).toBe("scale(2.5)");
    expect(box.style.width).toBe("40%");
    expect(box.style.height).toBe("40%");
    expect(box.className).toContain("origin-top-left");
  });

  /**
   * The identity, which is still drawn rather than skipped: one code path for
   * both, and a host that never has to ask whether the box is there.
   */
  test("covers the canvas untransformed at the authored options size", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarBox={220} optionsBox={44} />,
    );
    const box = boxOf(container);
    expect(box.style.transform).toBe("scale(1)");
    expect(box.style.width).toBe("100%");
    expect(box.style.height).toBe("100%");
  });

  /** The pill and the creature both hang inside that one box. */
  test("draws the whole surface inside that box", () => {
    const { container } = render(
      <CompanionSurface phase="hover" avatarBox={110} optionsBox={44} />,
    );
    const box = boxOf(container);
    expect(box.contains(surfaceOf(container))).toBe(true);
    expect(box.contains(avatarOf(container))).toBe(true);
  });

  /**
   * 55 to a huge creature's edge, then the gap the smaller of the two earns.
   * On its visible bottom as well: the near edge is 115 at this pair and the
   * artwork stops 35 in from the centre, so the pill's bottom lands 80 from the
   * canvas edge.
   */
  test("steps the pill off a larger creature's edge and onto its bottom", () => {
    const { container } = render(
      <CompanionSurface phase="hover" avatarBox={110} optionsBox={44} />,
    );
    expect(surfaceOf(container).style.left).toBe("calc(50% + 67px)");
    expect(avatarOf(container).style.top).toBe("calc(100% - 115px)");
    expect(surfaceOf(container).style.top).toBe("calc(100% - 80px)");
    expect(surfaceOf(container).style.transform).toBe("translateY(-100%)");
  });

  /**
   * The same rules the other way round, read in the pill's own units: 22 points
   * to the creature's edge and 12 of gap, at a scale of two and a half, and the
   * pill's bottom on the creature's visible bottom the same way.
   */
  test("steps it off a smaller creature and onto its bottom too", () => {
    const { container } = render(
      <CompanionSurface phase="hover" avatarBox={44} optionsBox={110} />,
    );
    expect(surfaceOf(container).style.left).toBe("calc(50% + 13.6px)");
    expect(avatarOf(container).style.top).toBe("calc(100% - 62.4px)");
    expect(surfaceOf(container).style.top).toBe("calc(100% - 56.8px)");
    expect(surfaceOf(container).style.transform).toBe("translateY(-100%)");
  });

  test("mirrors that step when the pill grows the other way", () => {
    const { container } = render(
      <CompanionSurface
        phase="hover"
        growth="left"
        avatarBox={110}
        optionsBox={44}
      />,
    );
    expect(surfaceOf(container).style.right).toBe("calc(50% + 67px)");
  });

  test("anchors both against the canvas's top edge when the card grows down", () => {
    const { container } = render(
      <CompanionSurface
        phase="hover"
        cardGrowth="down"
        avatarBox={110}
        optionsBox={44}
      />,
    );
    expect(avatarOf(container).style.top).toBe("115px");
    expect(surfaceOf(container).style.top).toBe("150px");
  });

  /**
   * The creature's own node carries the difference and nothing else does. It
   * has to be that node rather than either wrapper below it: the collapse owns
   * a `transform` and so does the bob, and two on one node leave one out.
   */
  test("scales the creature by the difference between the two boxes", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarBox={110} optionsBox={44} />,
    );
    expect(avatarOf(container).style.transform).toBe(
      "translate(-50%, -50%) scale(2.5)",
    );
    expect(bobOf(container)?.parentElement?.parentElement).toBe(
      avatarOf(container),
    );
  });

  test("scales it down the same way beside a larger pill", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarBox={44} optionsBox={110} />,
    );
    expect(avatarOf(container).style.transform).toBe(
      "translate(-50%, -50%) scale(0.4)",
    );
  });

  /** With the two agreeing the surface's own box has done all of it. */
  test("leaves the creature unscaled when the two agree", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarBox={110} optionsBox={110} />,
    );
    expect(avatarOf(container).style.transform).toBe("translate(-50%, -50%)");
    expect(avatarOf(container).style.top).toBe("calc(100% - 54px)");
  });
});

/**
 * The idle row's verbs, which are drawn one at a time under the pointer.
 *
 * **The behaviour is a stylesheet, so these hold its contract rather than its
 * effect.** The reveal is `:hover` and not React state, because the host's
 * window is click-through and the page derives its own hover from forwarded
 * mouse-move rather than from `mouseenter`; CSS is the one hover mechanism
 * known to work there, since the held-down background on these same buttons
 * runs on it. Nothing here renders Tailwind, so a case that fired a
 * synthetic hover and read the text back passes with the stylesheet missing
 * entirely. What is worth holding instead is the coupling: the word is
 * marked hidden-until-hovered, the button is the `group` that variant resolves
 * against, and the two cases that pin it open still pin it open.
 */
describe("the companion surface's revealed labels", () => {
  const labelOf = (container: HTMLElement, name: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(
      `button[aria-label="${name}"] span[data-label]`,
    );

  test("rests as icons, with no verb spelled out", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    for (const name of ["Talk", "Teach"]) {
      const label = labelOf(container, name);
      expect(label?.getAttribute("data-label")).toBe("hover");
      expect(label?.className).toContain("hidden");
    }
  });

  /**
   * The variant and the thing it resolves against, together. `group-hover:` on
   * a button that is not a `group` is a word that never appears, and that is
   * exactly the failure no rendered assertion in this file would catch.
   */
  test("reveals the verb under the pointer, from the button's own group", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    const talk = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Talk"]',
    );
    expect(talk?.className).toContain("group");
    expect(labelOf(container, "Talk")?.className).toContain(
      "group-hover:inline",
    );
  });

  /**
   * The reel has no pointer in the room, and the whole point of a spotlit frame
   * is which control it is pointing at.
   */
  test("spells out the control the reel is pointing at", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" watchEnabled />,
    );
    expect(labelOf(container, "Talk")?.getAttribute("data-label")).toBe(
      "pinned",
    );
    expect(labelOf(container, "Talk")?.className).not.toContain("hidden");
    // And only that one: a frame pointing at both is pointing at neither.
    expect(labelOf(container, "Teach")?.getAttribute("data-label")).toBe(
      "hover",
    );
  });

  /**
   * A running session is the one thing on this row the user has to be able to
   * find without hunting, so its name stays on the surface rather than under
   * the pointer.
   */
  test("keeps the running session's name drawn", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching watchEnabled />,
    );
    expect(labelOf(container, "Teach")?.getAttribute("data-label")).toBe(
      "pinned",
    );
    expect(labelOf(container, "Teach")?.className).not.toContain("hidden");
  });

  /**
   * The summary is a question waiting on an answer rather than a set of ways
   * in, so its two answers are not the pointer's to reveal.
   */
  test("leaves the summary's answers spelled out", () => {
    const { container } = render(
      <CompanionSurface phase="summary" watchRetro="ready" />,
    );
    expect(labelOf(container, "Show summary")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Show summary"]',
      )?.textContent,
    ).toBe("Show summary");
  });
});

/**
 * Watch, the third way in, and the session it toggles.
 *
 * One control for both edges: the surface draws a single button and the side
 * holding the session decides which edge a press is, so what a test can hold is
 * that the press is reported and that a running session is drawn as one.
 */
describe("the companion surface's Watch action", () => {
  const watchOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Teach"]',
    );
    if (!found) {
      throw new Error("Expected Watch to render");
    }
    return found;
  };

  test("sits on the idle pill beside Talk", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    // After Talk, since this is the row's own ordering and the one a hand
    // travelling out from the mascot crosses last.
    expect(
      [...container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Talk", "Teach"]);
  });

  test("reports the press", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="hover"
        watchEnabled
        onWatch={() => {
          presses += 1;
        }}
      />,
    );
    fireEvent.click(watchOf(container));
    expect(presses).toBe(1);
  });

  /**
   * A reader gets none of what this PR spends on the state: not the amber ring,
   * not the held-down background. The pressed state is the whole of what
   * reaches them, so it is what says a session is running and that the press
   * they are on will end it.
   */
  test("reports its pressed state while the session runs", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watching watchEnabled />,
    );
    expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
  });

  test("reports the state it is actually in while nothing runs", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    expect(watchOf(container).getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * `classList` rather than a substring, because every control carries
   * `hover:bg-white/15` and a substring match would pass on the hover rule
   * alone.
   */
  test("reads as held down while the session runs", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching watchEnabled />,
    );
    expect(watchOf(container).classList.contains("bg-white/15")).toBe(true);
  });

  test("reads as idle while no session runs", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    expect(watchOf(container).classList.contains("bg-white/15")).toBe(false);
  });

  /**
   * The flag, not the phase, the same input the ring reads. The two are drawn
   * in different places and must never be able to disagree about whether a
   * session is running.
   */
  test("reads as held down on the idle pill while the session runs", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watching watchEnabled />,
    );
    expect(watchOf(container).classList.contains("bg-white/15")).toBe(true);
  });
});

/**
 * The flag Watch is behind, as the surface draws it.
 *
 * The surface has no way of evaluating it: the window it lives in never
 * hydrates a flag store, so the answer arrives on the pushed state and this
 * prop is where it lands. What a case can hold is that the way into a session
 * is absent without a positive answer, and that a session already running is
 * still drawn and still stoppable when the answer goes away, because a capture
 * the user can neither see nor end is the failure this surface exists to
 * prevent.
 */
describe("the companion surface's Watch flag", () => {
  const watchButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Teach"]');

  test("draws no way in when the answer has not arrived", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(watchButton(container)).toBeNull();
  });

  test("draws no way in when the answer is no", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled={false} />,
    );
    expect(watchButton(container)).toBeNull();
  });

  test("leaves Talk where it was", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(container.querySelector('button[aria-label="Talk"]')).not.toBeNull();
  });

  /**
   * The flag hides the door, never the exit. A session that outlives the
   * answer is one the user has to be able to see and to end.
   */
  test("still draws the running session's ring", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching />,
    );
    expect(container.querySelector(".companion-working-ring")).not.toBeNull();
  });

  test("still draws the stop control on the call row", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(
      container.querySelector('button[aria-label="Stop teaching"]'),
    ).not.toBeNull();
  });

  /**
   * The idle row is where Watch itself is the stop, so hiding Watch there would
   * leave a running session with nothing that ends it. The stop takes its
   * place instead.
   */
  test("puts the stop where the way in would have been", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching />,
    );
    expect(
      container.querySelector('button[aria-label="Stop teaching"]'),
    ).not.toBeNull();
  });

  test("reports that press as the toggle it is", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="watching"
        watching
        onWatch={() => {
          presses += 1;
        }}
      />,
    );
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop teaching"]',
    );
    if (!stop) {
      throw new Error("Expected the stop control to render");
    }
    fireEvent.click(stop);
    expect(presses).toBe(1);
  });

  test("draws no stop while nothing is running", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(
      container.querySelector('button[aria-label="Stop teaching"]'),
    ).toBeNull();
  });
});

/**
 * The pill stays open for as long as the session does, hand or no hand.
 *
 * A capture that hid itself the moment the pointer left would be one the user
 * can neither see nor reach the control that ends it. The collapsed body is
 * `inert`, so its absence is the pill being genuinely open rather than merely
 * drawn.
 */
describe("the pill a watch session holds open", () => {
  test("stays open with the pointer nowhere near it", () => {
    const { container } = render(
      <CompanionSurface phase="watching" hovered={false} />,
    );
    expect(container.querySelector("[inert]")).toBeNull();
  });

  test("is shut at rest, which is what makes that a claim", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    expect(container.querySelector("[inert]")).not.toBeNull();
  });
});

/**
 * The way out of a session, which has to reach as far as the indicator does.
 *
 * `watching` ranks below `call`, so the idle row that carries Watch is not
 * drawn during a call while the ring still is. An indicator the user can see
 * and cannot act on is a worse bargain than no indicator at all: it names
 * something happening to them and withholds the means to end it. So the call
 * row carries a stop control of its own, on the same `onWatch` the idle row
 * presses.
 */
describe("the companion surface's stop control", () => {
  const stopOf = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop teaching"]',
    );

  const required = (container: HTMLElement): HTMLButtonElement => {
    const found = stopOf(container);
    if (!found) {
      throw new Error("Expected the stop control to render");
    }
    return found;
  };

  test("rides the call row", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(stopOf(container)).not.toBeNull();
  });

  test("ends the session from the call row", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="call"
        watching
        call={LISTENING_CALL}
        onWatch={() => {
          presses += 1;
        }}
      />,
    );
    fireEvent.click(required(container));
    expect(presses).toBe(1);
  });

  test("is absent from the call row with no session to stop", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(stopOf(container)).toBeNull();
  });
});

/**
 * The ceiling the Electron canvas is sized to.
 *
 * `companion-window.ts` sizes its window once, for the widest state this
 * surface has, and never resizes it: a canvas that grew with the phase would
 * move the window under the pointer mid-press. So a phase wider than the
 * ceiling is not a wide pill, it is a clipped one, and the fix is on the other
 * side of the bridge.
 */
/**
 * The second ending of a session: the wait for its summary, and the question
 * that follows it.
 *
 * A session ends when the user presses stop, and the account of it is written
 * afterwards by a turn that runs for the better part of a minute. Collapsing to
 * rest across that gap reads as the recording having been thrown away, and the
 * report would land in a thread nobody was ever shown.
 */
describe("the summary a finished watch session leaves on the surface", () => {
  const buttonOf = (
    container: HTMLElement,
    label: string,
  ): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  test("says the summary is being written while the turn runs", () => {
    const { container } = render(
      <CompanionSurface phase="summary" watchRetro="pending" />,
    );
    expect(container.textContent).toContain("Summarizing");
    // Nothing to press yet, so nothing that looks pressable.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("burns the session's own ring while it waits", () => {
    const { container } = render(
      <CompanionSurface phase="summary" watchRetro="pending" />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  // The ring outlives the phase, the same way the capture indicator does: a
  // call outranks the phase and the turn runs regardless.
  test("keeps that ring under a phase that outranks it", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watchRetro="pending"
      />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  test("asks once there is something to read", () => {
    const { container } = render(
      <CompanionSurface phase="summary" watchRetro="ready" />,
    );
    expect(buttonOf(container, "Show summary")).not.toBeNull();
    expect(buttonOf(container, "Not now")).not.toBeNull();
  });

  test("a yes asks for the report", () => {
    const answers: boolean[] = [];
    const { container } = render(
      <CompanionSurface
        phase="summary"
        watchRetro="ready"
        onWatchRetro={(open) => answers.push(open)}
      />,
    );

    fireEvent.click(buttonOf(container, "Show summary")!);

    expect(answers).toEqual([true]);
  });

  /**
   * The way out has to be as reachable as the way in. This surface floats over
   * whatever the user does next, so a prompt whose only dismissal is going
   * somewhere else is one that follows them around.
   */
  test("a no is an answer, not an absence of one", () => {
    const answers: boolean[] = [];
    const { container } = render(
      <CompanionSurface
        phase="summary"
        watchRetro="ready"
        onWatchRetro={(open) => answers.push(open)}
      />,
    );

    fireEvent.click(buttonOf(container, "Not now")!);

    expect(answers).toEqual([false]);
  });

  // The phase without the state behind it is the ordinary row, not an empty
  // one: nothing on this surface should draw a question with no answer in it.
  test("draws the ordinary controls when there is no summary", () => {
    // `watchEnabled` because this asserts the ordinary controls, and the flag
    // is what decides whether Teach is among them.
    const { container } = render(
      <CompanionSurface phase="summary" watchEnabled />,
    );
    expect(buttonOf(container, "Teach")).not.toBeNull();
  });
});

describe("the companion surface's width ceiling", () => {
  /**
   * The widest the pill may draw, which is what the canvas is sized for.
   * Written out rather than read from the contract, so the cases below assert a
   * number instead of restating the constant they are about.
   */
  const CANVAS_CEILING = 316;

  test("is the width the shared contract publishes", () => {
    expect(COMPANION_BASE_MAX_PILL_WIDTH).toBe(CANVAS_CEILING);
  });

  /**
   * The ceiling is on the pill, not on the body inside it, so a body that fits
   * with the clearance at either end left off is not one that fits.
   */
  test("holds for every measured body once the pill's own clearance is on it", () => {
    const over = Object.entries(FALLBACK_WIDTHS).filter(
      ([, width]) => width + 2 * INNER_GAP > CANVAS_CEILING,
    );
    expect(over).toEqual([]);
  });

  /**
   * The call row is the one the stop control grew, so the bound above is only
   * worth anything if the entry it checks is the width of the row *with* the
   * control on it. Five controls is what that row draws.
   */
  test("sizes the call entry for the row that carries the stop control", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(FALLBACK_WIDTHS.call).toBeGreaterThan(FALLBACK_WIDTHS.hover);
  });
});

/**
 * The indicator outlives the phase.
 *
 * `watching` ranks below `call`, so a session that is still reading the
 * screen is drawn under a phase that is not its own for as long as the user is
 * on a call. That is the phase where an indicator derived from the phase would
 * go dark, and going dark over a live capture is the failure this surface
 * exists to prevent.
 */
describe("the companion surface's capture indicator across phases", () => {
  test("survives a call, which outranks the watching phase", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  test("is absent on a call with no session running", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(ringOf(container)).toBeNull();
  });

  test("is absent in a call with no session running", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(ringOf(container)).toBeNull();
  });
});

/**
 * Growing leftward moves the pill and nothing else.
 *
 * Main positions the window by the *avatar's* centre and measures every later
 * drag, clamp and direction check from it. The renderer's half of that bargain
 * is to draw the avatar on the point the host aimed at, in both directions: the
 * avatar keeps its place and the pill swaps which of its edges is pinned to the
 * gap. A flip that moved the mascot instead would put it up to a card's width
 * from where main believes it is, so it would teleport at the threshold, the
 * labels would sweep under a held pointer, and the point main hands presses to
 * would land on a control that refuses them. The surface reads as dead
 * (JARVIS-1582).
 */
describe("the companion surface growing leftward", () => {
  test("anchors the pill by its right edge, a gap off the avatar", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="left" />,
    );
    expect(surfaceOf(container).style.right).toBe("calc(50% + 34px)");
    expect(surfaceOf(container).style.left).toBe("");
  });

  /** The pill's avatar-facing edge: the avatar's half box, then the gap. */
  test("anchors it by its left edge growing the ordinary way", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="right" />,
    );
    expect(surfaceOf(container).style.left).toBe("calc(50% + 34px)");
    expect(surfaceOf(container).style.right).toBe("");
  });

  /**
   * The row inside the pill ends on the pinned edge too. A row left-aligned in
   * a box narrower than its own content spills past that edge, across the gap
   * and over the creature, for as long as the animating width lags the
   * content: through the unfurl, and again on every label reveal.
   */
  test("ends the pill's row on the edge the pill is pinned by", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="left" />,
    );
    expect(surfaceOf(container).className).toContain("justify-end");

    const { container: rightward } = render(
      <CompanionSurface phase="hover" growth="right" />,
    );
    expect(surfaceOf(rightward).className).not.toContain("justify-end");
  });

  test("leaves the avatar on its own point either way", () => {
    for (const growth of ["left", "right"] as const) {
      const { container } = render(
        <CompanionSurface phase="hover" growth={growth} />,
      );
      expect(avatarOf(container).style.left).toBe("50%");
      cleanup();
    }
  });
});

/**
 * What the surface claims to be a toggle, which is one control.
 *
 * `active` draws a control as though a pointer were on it, which the demo reel
 * stages on Talk and Type to show a hand reaching for one. That is a look, and
 * a look reported as a pressed state would tell a reader that Talk is switched
 * on because a clip wanted it lit. Watch is the only control here that is
 * genuinely on or off, so it is the only one that says so.
 */
describe("the companion surface's pressed states", () => {
  const buttonsOf = (container: HTMLElement): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"));

  const named = (container: HTMLElement, label: string): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    if (!found) {
      throw new Error(`Expected ${label} to render`);
    }
    return found;
  };

  test("leaves the spotlit control unpressed, since a highlight is not a state", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" />,
    );
    expect(named(container, "Talk").getAttribute("aria-pressed")).toBeNull();
  });

  /**
   * The look and the announced state come from one input on Watch, so a
   * spotlight that drew a control held down without saying so is exactly the
   * split this separation exists to keep.
   */
  test("still draws the spotlit control held down", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" />,
    );
    expect(named(container, "Talk").classList.contains("bg-white/15")).toBe(
      true,
    );
  });

  test("claims no pressed state anywhere on the call row", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    for (const button of buttonsOf(container)) {
      expect(button.getAttribute("aria-pressed")).toBeNull();
    }
  });

  /**
   * The stop control goes one way and exists only while there is a session to
   * end, so it is an action. Its name is what tells a reader that something is
   * being watched and that this is the way out of it.
   */
  test("leaves the stop control an action rather than a toggle", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    const stop = named(container, "Stop teaching");
    expect(stop.getAttribute("aria-pressed")).toBeNull();
  });
});

/**
 * The whole surface is a drag handle that happens to have words on it, so a
 * press and a sweep across it is a drag and never a text selection. Without
 * this, a drag that crosses the direction flip highlights "Talk" and "Teach"
 * on the way past, and the selection it leaves behind arms the browser's own
 * text-drag against the next press (JARVIS-1582).
 */
describe("the companion surface's text selection", () => {
  test("is off across the surface", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(surfaceOf(container).className).toContain("select-none");
  });
});

/**
 * The idle motion, which is two animations that must not become one.
 *
 * `AnimatedAvatar` owns `transform` on its own `<svg>` for the breathe and the
 * morph, so the bob lives on a wrapper. Put both on one node and the browser
 * silently keeps whichever declaration came last, and the loss is invisible in
 * a screenshot.
 */
describe("the resting avatar's idle motion", () => {
  test("bobs on a wrapper of its own", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    expect(bobOf(container)).not.toBeNull();
  });

  /**
   * The creature carries no light of its own: a blurred disc of the accent
   * behind it made it read as a lit control rather than as something standing
   * on the desktop, so nothing is painted behind the artwork in any phase.
   */
  test("draws nothing behind the creature", () => {
    for (const phase of PHASES) {
      const { container } = render(
        <CompanionSurface phase={phase} accentHex="#ff8800" />,
      );
      expect(container.querySelector(".companion-glow")).toBeNull();
      expect(bobOf(container)?.querySelector(".blur-lg")).toBeNull();
      cleanup();
    }
  });

  /**
   * The artwork keeps its own animated node under the wrapper, which is what
   * makes the two transforms compose rather than replace each other.
   */
  test("leaves the artwork on a node below the bob", () => {
    const { container } = render(
      <CompanionSurface
        phase="resting"
        character={{ bodyShape: "blob", eyeStyle: "curious", color: "teal" }}
      />,
    );

    expect(bobOf(container)?.querySelector("svg")).not.toBeNull();
  });

  /**
   * The wrapper sits inside the avatar's box, which nothing else may move.
   *
   * The collapse that tucks the creature into the capsule is a `transform` of
   * its own, so it takes a wrapper of its own rather than riding the bob and
   * silently replacing it. Both links are asserted, since what has to hold is
   * the whole chain from the box the host measures down to the artwork.
   */
  test("keeps the avatar box above the wrapper, one node up", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    const bob = bobOf(container);
    const collapse = bob?.parentElement;
    expect(collapse?.className).toContain("transition-[opacity,transform]");
    expect(collapse?.parentElement?.className).toContain("size-11");
  });

  /** Each transform on a node of its own, which is the whole point of them. */
  test("gives the collapse and the bob separate nodes", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    const collapse = bobOf(container)?.parentElement;
    expect(collapse?.style.transform).toBe("scale(0.35)");
    expect(bobOf(container)?.style.transform).toBe("");
  });

  /**
   * A reader who has asked for stillness gets it from two places: the
   * `prefers-reduced-motion` block beside the keyframes, and the inline
   * `animation: none` here. The doubling is deliberate, since a stylesheet that
   * failed to load is a surface that moves anyway, and this is the half a
   * reader of the component can see.
   *
   * Held still rather than dropped: the bob's baseline is where the creature
   * belongs, so it stays drawn.
   */
  test("holds the bob still under reduced motion", () => {
    reducedMotion = true;

    const { container } = render(<CompanionSurface phase="resting" />);

    expect(bobOf(container)?.style.animation).toBe("none");
  });

  test("leaves it running for a reader who asked for nothing", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    expect(bobOf(container)?.style.animation).toBe("");
  });

  /**
   * The collapse is motion too, and the newest of it. Hovering the capsule
   * grows a shape and scales a creature, which is exactly the travel across
   * the screen a reader asking for stillness is asking not to have.
   *
   * The shape arrives changed; the creature keeps its fade, since a cross-fade
   * is not motion across the screen and is gentler than snapping in and out.
   */
  test("holds the collapse still under reduced motion", () => {
    reducedMotion = true;

    const { container } = render(<CompanionSurface phase="resting" />);

    expect(shapeOf(container).style.transitionDuration).toBe("0s");
    expect(bobOf(container)?.parentElement?.style.transitionProperty).toBe(
      "opacity",
    );
  });

  test("lets the collapse travel for a reader who asked for nothing", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    expect(shapeOf(container).style.transitionDuration).toBe("");
    expect(bobOf(container)?.parentElement?.style.transitionProperty).toBe("");
  });
});

/**
 * The resting collapse.
 *
 * At rest this surface is a marker rather than a mascot: it sits over whatever
 * the user is working in all day, so the creature gives way to a thin capsule
 * and comes back the moment anything opens the pill.
 *
 * What must not move with it is the box the shape is drawn in. That box is the
 * drag handle, the point the host positions the window around, and the rect the
 * pointer is hit-tested against, so a collapse that shrank it would move the
 * anchor every drag and clamp is measured from.
 */
describe("the avatar's resting collapse", () => {
  test("draws a capsule at rest", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    const shape = shapeOf(container);
    expect(shape.style.width).toBe("28px");
    expect(shape.style.height).toBe("10px");
  });

  /**
   * Sizing the creature is a statement about the creature. Someone who wants a
   * big mascot when they look at it has not asked for a big lozenge sitting
   * over their work all day, so the marker is the one part of this surface the
   * setting does not reach.
   */
  test("draws the capsule at one size whatever the creature is sized to", () => {
    for (const avatarBox of [44, 66, 110, 220]) {
      const { container } = render(
        <CompanionSurface phase="resting" avatarBox={avatarBox} />,
      );

      const shape = shapeOf(container);
      // The lengths are the same on every setting, and the transform undoes
      // the scale this node carries, which is the avatar's box over 44. The
      // box is the accent itself, 28 by 10.
      expect(shape.style.width).toBe("28px");
      expect(shape.style.height).toBe("10px");
      expect(shape.style.transform).toBe(
        `translate(-50%, -50%) scale(${44 / avatarBox})`,
      );
    }
  });

  /** Expanded it is the creature's own box, which the setting does reach. */
  test("still grows the expanded shape with the creature", () => {
    const { container } = render(
      <CompanionSurface phase="hover" avatarBox={220} />,
    );

    const shape = shapeOf(container);
    expect(shape.style.width).toBe("44px");
    expect(shape.style.transform).toBe("translate(-50%, -50%) scale(1)");
  });

  test("draws the whole box once anything opens the pill", () => {
    for (const phase of PHASES.filter((it) => it !== "resting")) {
      const { container } = render(<CompanionSurface phase={phase} />);

      const shape = shapeOf(container);
      expect(shape.style.width).toBe("44px");
      expect(shape.style.height).toBe("44px");
    }
  });

  /**
   * The box the host measures is the same box in every phase. This is the one
   * assertion here that is about the window rather than the drawing: shrink it
   * and every drag, clamp and growth flip is measured from a different point.
   */
  test("never resizes the box the shape is drawn in", () => {
    for (const phase of PHASES) {
      const { container } = render(<CompanionSurface phase={phase} />);

      expect(avatarOf(container).className).toContain("size-11");
    }
  });

  /**
   * A ring is a statement about the shape it is drawn around, so a turn
   * running while the surface is at rest lights the capsule rather than
   * circling the empty box the capsule sits in.
   */
  test("rides the ring on the shape, not on the box", () => {
    const { container } = render(<CompanionSurface phase="resting" working />);

    expect(ringOf(container)?.parentElement).toBe(shapeOf(container));
  });

  /**
   * The capsule is the assistant's colour and nothing else. A dark rim made a
   * creature peeking out from behind it read as coming out of a slot in a
   * device rather than out of its own shape.
   */
  test("wears no rim", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

    const capsule = capsuleOf(container);
    expect(capsule.style.borderWidth).toBe("");
    expect(capsule.style.borderStyle).toBe("");
  });

  /**
   * The capsule holds its size and fades where it stands.
   *
   * Sized on itself rather than filling the ring's box, which grows to the
   * creature's. An accent inflating to that box and dissolving reads as a
   * bubble popping rather than as the creature coming out of the pill.
   */
  test("never grows the capsule with the box the ring rides", () => {
    for (const phase of PHASES) {
      const { container } = render(<CompanionSurface phase={phase} />);

      const capsule = capsuleOf(container);
      expect(capsule.style.width).toBe("28px");
      expect(capsule.style.height).toBe("10px");
    }
  });

  /**
   * The introduction's first beat presents the creature by name and does not
   * open the pill, so the phase is `resting` while a card points at it. A card
   * introducing the capsule is the one thing this collapse must not do.
   */
  test("keeps the creature drawn while the introduction is on screen", () => {
    const { container } = render(
      <CompanionSurface phase="resting" intro={<div>meet</div>} />,
    );

    const shape = shapeOf(container);
    expect(shape.style.height).toBe("44px");
    expect(bobOf(container)?.parentElement?.style.opacity).toBe("1");
  });

  /** The box the words are drawn in, the one that takes its direction from them. */
  const transcriptBox = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[dir=auto]");

  /**
   * The words are the point of the state. A speaker dictating into another
   * application cannot see what landed there yet, and this is the only surface
   * telling them anything.
   */
  test("draws the words once there are any", () => {
    const { container } = render(
      <CompanionSurface
        phase="dictating"
        dictating="listening"
        dictationText="the quick brown fox"
      />,
    );

    expect(container.textContent).toContain("the quick brown fox");
  });

  /** Until then the status word stands in, rather than an empty line. */
  test("falls back to the status word with nothing recognised yet", () => {
    const { container } = render(
      <CompanionSurface phase="dictating" dictating="listening" />,
    );

    expect(container.textContent).toContain("Listening");
  });

  test("says it is thinking once the keys are up", () => {
    const { container } = render(
      <CompanionSurface phase="dictating" dictating="transcribing" />,
    );

    expect(container.textContent).toContain("Thinking");
  });

  /**
   * A line that filled from the start would freeze on the opening words and
   * leave the speaker watching the part they are least unsure of. The words
   * sit at the end of their box, so a run longer than the box overflows at
   * the start, where the clipping is. The end is the words' own: the box
   * takes its direction from them rather than forcing one, so a right-to-left
   * transcript keeps its last words in view the same way.
   */
  test("clips the words from the front, not the end", () => {
    const { container } = render(
      <CompanionSurface
        phase="dictating"
        dictating="listening"
        dictationText="a sentence long enough to run past the end of the pill"
      />,
    );

    const box = transcriptBox(container);
    expect(box).not.toBeNull();
    expect(box?.className).toContain("justify-end");
    expect(box?.className).toContain("overflow-hidden");
    expect(box?.getAttribute("dir")).toBe("auto");
    expect(box?.style.direction).toBe("");
    // Revised several times a second; a live region would read every guess.
    expect(box?.getAttribute("aria-live")).toBeNull();
  });

  /**
   * Every other body here is as wide as its content, and a sentence has no
   * width to be as wide as. A stated width is what keeps the pill inside the
   * canvas main sized for it, and what keeps it still: the box is the same
   * size with three words as with three hundred, and the same size as the
   * status word's box before there were any, so the pill grows to its
   * dictating width once rather than on every partial.
   */
  test("gives the words a fixed box rather than measuring them", () => {
    const widthOf = (text?: string) => {
      const { container } = render(
        <CompanionSurface
          phase="dictating"
          dictating="listening"
          dictationText={text}
        />,
      );
      const box =
        transcriptBox(container) ??
        container.querySelector<HTMLElement>(".truncate");
      return box?.style.width;
    };

    expect(widthOf("x".repeat(400))).toBe("244px");
    expect(widthOf("three words here")).toBe("244px");
    expect(widthOf(undefined)).toBe("244px");
  });

  /** The creature fades with it rather than being cut, and comes back whole. */
  test("fades the creature out at rest and back in expanded", () => {
    const { container: resting } = render(<CompanionSurface phase="resting" />);
    expect(bobOf(resting)?.parentElement?.style.opacity).toBe("0");

    const { container: hovered } = render(<CompanionSurface phase="hover" />);
    expect(bobOf(hovered)?.parentElement?.style.opacity).toBe("1");
  });
});

/** The capsule's peek, which is drawn only for a composed creature. */
const peekOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-peek");

describe("the resting capsule's peek", () => {
  const CHARACTER = { bodyShape: "urchin", eyeStyle: "curious", color: "teal" };

  test("is there at rest for a composed creature", () => {
    const { container } = render(
      <CompanionSurface phase="resting" character={CHARACTER} />,
    );
    expect(peekOf(container)).not.toBeNull();
    expect(peekOf(container)?.style.opacity).toBe("1");
  });

  /** A custom image has no creature in it, so there is nobody to peek. */
  test("is absent for a custom image", () => {
    const { container } = render(
      <CompanionSurface phase="resting" avatarSrc="data:image/png;base64," />,
    );
    expect(peekOf(container)).toBeNull();
  });

  /**
   * The creature is out of the capsule, and the capsule has faded where it
   * stands; the peek goes with it rather than rising beside the creature.
   */
  test("fades with the capsule once the creature is out", () => {
    const { container } = render(
      <CompanionSurface phase="hover" character={CHARACTER} />,
    );
    expect(peekOf(container)?.style.opacity).toBe("0");
  });

  /** Rides the capsule's transform, so it is drawn at the capsule's one size. */
  test("counters the creature's scale the way the capsule does", () => {
    const { container } = render(
      <CompanionSurface
        phase="resting"
        character={CHARACTER}
        avatarBox={COMPANION_BASE_AVATAR_BOX * 2}
      />,
    );
    expect(peekOf(container)?.style.transform).toContain("scale(0.5)");
  });

  test("is not drawn for a reader who asked for stillness", () => {
    reducedMotion = true;
    const { container } = render(
      <CompanionSurface phase="resting" character={CHARACTER} />,
    );
    expect(peekOf(container)).toBeNull();
  });
});
