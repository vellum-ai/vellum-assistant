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

const { CompanionSurface, FALLBACK_WIDTHS, INNER_GAP, NAME_DWELL_MS } =
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

/** A control on the pill, found by the name a reader is given for it. */
const buttonOf = (
  container: HTMLElement,
  label: string,
): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

/** Every state the surface draws, which several cases here sweep in turn. */
const PHASES = ["resting", "hover", "watching", "summary", "call"] as const;

/** The wrapper the idle bob runs on, which sits inside the avatar's box. */
const bobOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-avatar-bob");

/** A composed creature, for the cases about the pose it holds. */
const CREATURE = {
  bodyShape: "burst",
  eyeStyle: "curious",
  color: "orange",
} as const;

/** Whether the creature is holding the working pose the chat avatar holds. */
const busyOf = (container: HTMLElement): boolean =>
  container.querySelector('[data-busy="true"]') !== null;

/**
 * The creature carries the state: the surface's answer to "is it doing
 * anything", drawn so it can be read without reading, and drawn the way the
 * chat draws it. A working creature holds the focused, morphing pose the chat
 * avatar holds while a reply streams. There is no ring: the creature is the
 * whole signal, for a turn and for a session reading the screen alike.
 */
describe("the creature carrying the state", () => {
  const character = CREATURE;

  test("is still while nothing is running", () => {
    const { container } = render(
      <CompanionSurface phase="hover" character={character} />,
    );
    expect(busyOf(container)).toBe(false);
  });

  test("holds the working pose for a typed turn", () => {
    const { container } = render(
      <CompanionSurface phase="hover" character={character} working />,
    );
    expect(busyOf(container)).toBe(true);
  });

  test("holds it for a call's assistant turn without a published flag", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        character={character}
        call={{ ...LISTENING_CALL, phase: "speaking" }}
      />,
    );
    expect(busyOf(container)).toBe(true);
  });

  test("holds it for a session reading the screen", () => {
    const { container } = render(
      <CompanionSurface phase="watching" character={character} watching />,
    );
    expect(busyOf(container)).toBe(true);
  });

  test("holds it while a summary is being written", () => {
    const { container } = render(
      <CompanionSurface
        phase="summary"
        character={character}
        watchRetro="pending"
      />,
    );
    expect(busyOf(container)).toBe(true);
  });

  test("draws no ring on the creature for any of them", () => {
    for (const props of [
      { working: true },
      { watching: true },
      { watchRetro: "pending" as const },
    ]) {
      const { container } = render(
        <CompanionSurface phase="hover" character={character} {...props} />,
      );
      expect(
        container.querySelector(".size-11 .companion-working-ring"),
      ).toBeNull();
      cleanup();
    }
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
 * The capsule drawn inside that box, which is the shape at rest: the box's
 * first child, sized on itself and faded once the surface is expanded.
 */
const capsuleOf = (container: HTMLElement): HTMLElement => {
  const found = avatarOf(container).firstElementChild as HTMLElement | null;
  if (found === null) {
    throw new Error("Expected the resting capsule to render");
  }
  return found;
};

/** The same node under the name the collapse's cases read it by. */
const shapeOf = capsuleOf;

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
  test("keeps the avatar's own point in every phase but the call", () => {
    // The call bar is the one exception, and a deliberate one: the bar is
    // what stays on the point, and the creature steps aside to stand beside
    // it. See "the companion surface's call bar".
    for (const phase of PHASES.filter((candidate) => candidate !== "call")) {
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
      <CompanionSurface phase="call" call={LISTENING_CALL} watchEnabled />,
    );
    const label = labelOf(container, "Teach");
    expect(label?.getAttribute("data-label")).toBe("hover");
    expect(label?.className).toContain("hidden");
  });

  /**
   * The variant and the thing it resolves against, together. `group-hover:` on
   * a button that is not a `group` is a word that never appears, and that is
   * exactly the failure no rendered assertion in this file would catch.
   */
  test("reveals the verb under the pointer, from the button's own group", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} watchEnabled />,
    );
    const teach = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Teach"]',
    );
    expect(teach?.className).toContain("group");
    expect(labelOf(container, "Teach")?.className).toContain(
      "group-hover:inline",
    );
  });

  /**
   * The reel has no pointer in the room, and the whole point of a spotlit frame
   * is what it is pointing at: the creature, named for the press.
   */
  test("spells out the creature's name for the reel", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" />,
    );
    expect(
      container
        .querySelector("[data-companion-name]")
        ?.getAttribute("data-companion-name"),
    ).toBe("shown");
  });

  /**
   * A running session is the one thing on this row the user has to be able to
   * find without hunting, so its name stays on the surface rather than under
   * the pointer.
   */
  test("keeps the running session's name drawn", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watching
        watchEnabled
      />,
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
 * Teach, and the session it toggles.
 *
 * A thing done from inside the call, so it rides the call row and not the idle
 * pill, where Talk is the one way in. One control for both edges: the surface
 * draws a single button and the side holding the session decides which edge a
 * press is, so what a test can hold is that the press is reported and that a
 * running session is drawn as one.
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

  test("is not on the idle surface, where the creature is the way in", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("sits on the call row beside what the session is doing", () => {
    const { container } = render(
      <CompanionSurface phase="call" watchEnabled call={LISTENING_CALL} />,
    );
    // Ahead of the mutes and well away from End: two stops next to each
    // other is a misclick that ends the wrong thing.
    expect(
      [...container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Teach", "Mute microphone", "Mute assistant", "End session"]);
  });

  test("reports the press", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
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
   * The way in may be a question first. A page that can ask what to read
   * takes the press with no session running; the stop is the session's and
   * never a question.
   */
  test("hands the way in to the page that asks first, and the stop to the session", () => {
    const presses: string[] = [];
    const surface = (watching: boolean) => (
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watchEnabled
        watching={watching}
        onWatch={() => {
          presses.push("watch");
        }}
        onTeach={() => {
          presses.push("teach");
        }}
      />
    );
    const { container, rerender } = render(surface(false));
    fireEvent.click(watchOf(container));
    rerender(surface(true));
    fireEvent.click(watchOf(container));
    expect(presses).toEqual(["teach", "watch"]);
  });

  test("is held down while the question is open", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watchEnabled
        picking
      />,
    );
    expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
  });

  test("draws the picker it is handed beside the surface", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watchEnabled
        picking
        picker={<div data-testid="picker" />}
      />,
    );
    expect(container.querySelector('[data-testid="picker"]')).not.toBeNull();
  });

  /**
   * A reader gets none of what this surface spends on the state: not the amber
   * ring, not the held-down background. The pressed state is the whole of what
   * reaches them, so it is what says a session is running and that the press
   * they are on will end it.
   */
  test("reports its pressed state while the session runs", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watching
        watchEnabled
      />,
    );
    expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
  });

  test("reports the state it is actually in while nothing runs", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} watchEnabled />,
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
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watching
        watchEnabled
      />,
    );
    expect(watchOf(container).classList.contains("bg-white/15")).toBe(true);
  });

  test("reads as idle while no session runs", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} watchEnabled />,
    );
    expect(watchOf(container).classList.contains("bg-white/15")).toBe(false);
  });

  /**
   * A session running with no call to carry the toggle still has its stop:
   * the idle row draws it for as long as the screen is being read.
   */
  test("leaves the stop on the idle pill for a session already running", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching watchEnabled />,
    );
    expect(
      [...container.querySelectorAll("button")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Stop teaching"]);
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
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(watchButton(container)).toBeNull();
  });

  test("draws no way in when the answer is no", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        watchEnabled={false}
      />,
    );
    expect(watchButton(container)).toBeNull();
  });

  test("leaves the creature's press where it was", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(
      container.querySelector('[role="button"][aria-label="Talk"]'),
    ).not.toBeNull();
  });

  /**
   * The flag hides the door, never the exit. A session that outlives the
   * answer is one the user has to be able to see and to end.
   */
  test("still holds the working pose for the running session", () => {
    const { container } = render(
      <CompanionSurface phase="watching" character={CREATURE} watching />,
    );
    expect(busyOf(container)).toBe(true);
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
   * The idle row carries the stop whatever the flag says: a running session
   * with nothing that ends it is the failure this surface exists to prevent.
   */
  test("keeps the stop on the idle row", () => {
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
 * The call bar: the pill closed around the creature for a call, rather than
 * hanging off its side. Centred on the creature's own point so the host can
 * centre it on the display, and lit at its edge in the assistant's colour.
 */
describe("the companion surface's call bar", () => {
  const pillOf = (container: HTMLElement): HTMLElement => {
    const pill = container.querySelector<HTMLElement>(
      ".transition-\\[width\\]",
    );
    if (!pill) {
      throw new Error("Expected the pill to render");
    }
    return pill;
  };
  const creatureOf = (container: HTMLElement): HTMLElement => {
    const creature = container.querySelector<HTMLElement>(".size-11");
    if (!creature) {
      throw new Error("Expected the creature to render");
    }
    return creature;
  };

  test("is centred on the creature's point rather than hung off its side", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    const pill = pillOf(container);
    expect(pill.style.left).toBe("50%");
    expect(pill.style.transform).toBe("translate(-50%, -50%)");
  });

  test("hangs off the creature's side in every other open phase", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    const pill = pillOf(container);
    expect(pill.style.left).not.toBe("50%");
    expect(pill.style.transform).toBe("translateY(-100%)");
  });

  /**
   * Half the bar back from the centre, then the gap and the creature's own
   * half box: 12 and 22 at the base pair, the same step the pill takes off the
   * creature in every other phase, read from the bar's side.
   */
  test("stands the creature beside the bar's leading end, across the gap", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    const half = parseFloat(pillOf(container).style.width) / 2;
    expect(creatureOf(container).style.left).toBe(`calc(50% - ${half + 34}px)`);
  });

  test("steps the creature off the bar by the gap the pair earns", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        avatarBox={110}
        optionsBox={44}
      />,
    );
    const half = parseFloat(pillOf(container).style.width) / 2;
    expect(creatureOf(container).style.left).toBe(`calc(50% - ${half + 67}px)`);
  });

  test("leaves the creature on its own point outside a call", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(creatureOf(container).style.left).toBe("50%");
  });

  test("keeps the same clearance ahead of the body as every other pill", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    const row = pillOf(container).querySelector<HTMLElement>(".h-11.shrink-0");
    expect(row?.style.paddingInline).toBe(`${INNER_GAP}px`);
  });

  /**
   * The pill's own ring, as against the creature's: the creature burns its
   * ring for a turn, and this one is the bar's for the call.
   */
  const ringOf = (container: HTMLElement): HTMLElement | null =>
    pillOf(container).querySelector<HTMLElement>(".companion-working-ring");

  test("carries a pulse on its edge in the call's own colour", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        accentHex="#ff9f45"
      />,
    );
    const ring = ringOf(container);
    expect(ring).not.toBeNull();
    expect(ring?.style.getPropertyValue("--companion-ring-accent")).toBe(
      "#ff9f45",
    );
    expect(ring?.className).toContain("pointer-events-none");
  });

  test("keeps the light on the edge and out of the bar", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    const body = pillOf(container).querySelector<HTMLElement>(
      ".bg-\\[\\#17181b\\]\\/95",
    );
    expect(body).not.toBeNull();
    expect(body?.className).not.toContain("companion-working-ring");
  });

  test("is the plain pill again outside a call", () => {
    const { container } = render(
      <CompanionSurface phase="watching" watching />,
    );
    expect(ringOf(container)).toBeNull();
  });

  test("pulses for the dial too, which is the call's first beat", () => {
    const { container } = render(
      <CompanionSurface phase="call" assistantName="Ziggy" />,
    );
    expect(ringOf(container)).not.toBeNull();
    expect(pillOf(container).style.left).toBe("50%");
  });
});

/**
 * The creature is the call button.
 *
 * A press on it starts a call when idle and goes back to Vellum on a call;
 * the caller decides which by the session it holds, and this side names the
 * press for a reader by the phase. Hover unfurls nothing: the creature comes
 * out, and after a dwell says what a press does, as a name and not a control.
 */
describe("the creature as the call button", () => {
  const creatureOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>('[role="button"]');
  const nameOf = (container: HTMLElement): string | null =>
    container
      .querySelector("[data-companion-name]")
      ?.getAttribute("data-companion-name") ?? null;

  test("is named for the call while idle", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(creatureOf(container)?.getAttribute("aria-label")).toBe("Talk");
  });

  test("is named for the way back to Vellum on a call", () => {
    const { container } = render(
      <CompanionSurface phase="call" call={LISTENING_CALL} />,
    );
    expect(creatureOf(container)?.getAttribute("aria-label")).toBe(
      "Open Vellum",
    );
  });

  test("reports the press", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="hover"
        onAvatarClick={() => {
          presses += 1;
        }}
      />,
    );
    fireEvent.click(creatureOf(container)!);
    expect(presses).toBe(1);
  });

  test("unfurls no pill on hover", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(container.querySelector("[inert]")).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("holds its name back until the hand has dwelt", async () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(nameOf(container)).toBe("hidden");
    await new Promise((resolve) => {
      setTimeout(resolve, NAME_DWELL_MS + 50);
    });
    expect(nameOf(container)).toBe("shown");
  });

  test("keeps its name to itself at rest", () => {
    const { container } = render(<CompanionSurface phase="resting" />);
    expect(nameOf(container)).toBe("hidden");
  });

  /**
   * The name is the creature's, so a reader gets it once, from the creature,
   * and never as a second thing beside it.
   */
  test("hides the name from a reader, who has it from the creature", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" />,
    );
    expect(
      container
        .querySelector("[data-companion-name]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});

/**
 * The dial: Talk pressed, and the session it asked for not yet on the surface.
 *
 * The press leaves the surface at once and the session opens after a network
 * round trip in a window the user cannot see, so the pill has to be the thing
 * that says the press landed.
 */
describe("the companion surface's dial", () => {
  test("says who is being called", () => {
    const { container } = render(
      <CompanionSurface phase="call" assistantName="Ziggy" />,
    );
    expect(container.textContent).toContain("Calling Ziggy…");
  });

  test("says it is calling with no name to say", () => {
    const { container } = render(<CompanionSurface phase="call" />);
    expect(container.textContent).toContain("Calling…");
    expect(container.textContent).not.toContain("Calling …");
  });

  test("offers the end, which takes the request back", () => {
    const actions: string[] = [];
    const { container } = render(
      <CompanionSurface
        phase="call"
        assistantName="Ziggy"
        onControl={(action) => {
          actions.push(action);
        }}
      />,
    );
    fireEvent.click(buttonOf(container, "End session")!);
    expect(actions).toEqual(["endSession"]);
  });

  /**
   * Nothing to mute yet. A press on either would be dropped by the window
   * asked, so the controls are not drawn rather than drawn and inert.
   */
  test("draws no mutes with nothing to mute", () => {
    const { container } = render(
      <CompanionSurface phase="call" assistantName="Ziggy" />,
    );
    expect(buttonOf(container, "Mute microphone")).toBeNull();
    expect(buttonOf(container, "Mute assistant")).toBeNull();
  });

  test("keeps the stop of a session already reading the screen", () => {
    const { container } = render(
      <CompanionSurface phase="call" assistantName="Ziggy" watching />,
    );
    expect(buttonOf(container, "Stop teaching")).not.toBeNull();
  });

  test("gives way to the session once it arrives", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="call" assistantName="Ziggy" />,
    );
    rerender(
      <CompanionSurface
        phase="call"
        assistantName="Ziggy"
        call={LISTENING_CALL}
      />,
    );
    expect(container.textContent).not.toContain("Calling");
    expect(buttonOf(container, "Mute microphone")).not.toBeNull();
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
  test("says the summary is being written while the turn runs", () => {
    const { container } = render(
      <CompanionSurface phase="summary" watchRetro="pending" />,
    );
    expect(container.textContent).toContain("Summarizing");
    // Nothing to press yet, so nothing that looks pressable.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  test("holds the working pose while it waits", () => {
    const { container } = render(
      <CompanionSurface
        phase="summary"
        character={CREATURE}
        watchRetro="pending"
      />,
    );
    expect(busyOf(container)).toBe(true);
  });

  // The pose outlives the phase, the same way the capture indicator does: a
  // call outranks the phase and the turn runs regardless.
  test("keeps that pose under a phase that outranks it", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        character={CREATURE}
        call={LISTENING_CALL}
        watchRetro="pending"
      />,
    );
    expect(busyOf(container)).toBe(true);
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
  test("draws no question when there is no summary", () => {
    const { container } = render(<CompanionSurface phase="summary" />);
    expect(buttonOf(container, "Show summary")).toBeNull();
    expect(buttonOf(container, "Not now")).toBeNull();
  });
});

describe("the companion surface's width ceiling", () => {
  /**
   * The widest the pill may draw, which is what the canvas is sized for.
   * Written out rather than read from the contract, so the cases below assert a
   * number instead of restating the constant they are about.
   */
  const CANVAS_CEILING = 400;

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
    expect(FALLBACK_WIDTHS.call).toBeGreaterThan(FALLBACK_WIDTHS.watching);
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
      <CompanionSurface
        phase="call"
        character={CREATURE}
        watching
        call={LISTENING_CALL}
      />,
    );
    expect(busyOf(container)).toBe(true);
  });

  test("is absent on a call with no session running", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        character={CREATURE}
        call={LISTENING_CALL}
      />,
    );
    expect(busyOf(container)).toBe(false);
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

  test("leaves the spotlit creature unpressed, since a highlight is not a state", () => {
    const { container } = render(
      <CompanionSurface phase="hover" spotlight="talk" />,
    );
    expect(
      container
        .querySelector('[role="button"][aria-label="Talk"]')
        ?.getAttribute("aria-pressed"),
    ).toBeNull();
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

    expect(bobOf(container)?.parentElement?.style.transitionProperty).toBe(
      "opacity",
    );
  });

  test("lets the collapse travel for a reader who asked for nothing", () => {
    const { container } = render(<CompanionSurface phase="resting" />);

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
   * The capsule holds its size and fades where it stands. An accent inflating
   * to the creature's box and dissolving would read as a bubble popping rather
   * than as the creature coming out of the pill.
   */
  test("never grows the capsule with the creature", () => {
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

describe("the companion surface's Share action", () => {
  const shareOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Share"]',
    );
    if (!found) {
      throw new Error("Expected Share to render");
    }
    return found;
  };
  const labelsOf = (container: HTMLElement): (string | null)[] =>
    [...container.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );

  test("sits on the call row beside Teach", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        watchEnabled
        shareEnabled
        call={LISTENING_CALL}
      />,
    );
    expect(labelsOf(container)).toEqual([
      "Teach",
      "Share",
      "Mute microphone",
      "Mute assistant",
      "End session",
    ]);
  });

  test("is absent, not disabled, when the call cannot be shown anything", () => {
    const { container } = render(
      <CompanionSurface phase="call" watchEnabled call={LISTENING_CALL} />,
    );
    expect(labelsOf(container)).not.toContain("Share");
  });

  test("is not on the dial, where there is no session to show", () => {
    const { container } = render(
      <CompanionSurface phase="call" watchEnabled shareEnabled />,
    );
    expect(labelsOf(container)).toEqual(["Teach", "End session"]);
  });

  test("keeps its stop for a share running after the answer turned negative", () => {
    const { container } = render(
      <CompanionSurface phase="call" sharing call={LISTENING_CALL} />,
    );
    expect(shareOf(container).getAttribute("aria-pressed")).toBe("true");
  });

  test("hands the way in to the page, and the stop to the session", () => {
    const presses: string[] = [];
    const surface = (sharing: boolean) => (
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        shareEnabled
        sharing={sharing}
        onShare={() => {
          presses.push("share");
        }}
        onStopShare={() => {
          presses.push("stop");
        }}
      />
    );
    const { container, rerender } = render(surface(false));
    fireEvent.click(shareOf(container));
    rerender(surface(true));
    fireEvent.click(shareOf(container));
    expect(presses).toEqual(["share", "stop"]);
  });

  test("is held down for the choice before the share, and spells its name", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={LISTENING_CALL}
        shareEnabled
        sharePicking
      />,
    );
    expect(shareOf(container).getAttribute("aria-pressed")).toBe("true");
    expect(
      shareOf(container)
        .querySelector("[data-label]")
        ?.getAttribute("data-label"),
    ).toBe("pinned");
  });
});
