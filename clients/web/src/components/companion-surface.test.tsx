import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { VoiceActivityState } from "@vellumai/ipc-contract";

import { CompanionSurface, FALLBACK_WIDTHS } from "./companion-surface";

afterEach(cleanup);

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

  test("follows the card's corner radius while typing", () => {
    const { container, rerender } = render(
      <CompanionSurface phase="typing" watching captureCount={0} />,
    );

    rerender(<CompanionSurface phase="typing" watching captureCount={1} />);

    expect(pulseOf(container)?.className).toContain("rounded-[24px]");
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
/** The pill itself, which is also the surface's drag handle. */
const surfaceOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>(".cursor-grab");
  if (!found) {
    throw new Error("Expected the surface to render");
  }
  return found;
};

describe("the companion surface's anchor in the canvas", () => {
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

  test("sits on the idle pill beside Talk and Type", () => {
    const { container } = render(
      <CompanionSurface phase="hover" watchEnabled />,
    );
    expect(watchOf(container).textContent).toBe("Teach");
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

  test("leaves Talk and Type where they were", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(container.querySelector('button[aria-label="Talk"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Type"]')).not.toBeNull();
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

  test("still draws the stop control on the card", () => {
    const { container } = render(<CompanionSurface phase="typing" watching />);
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
 * `watching` ranks below `typing` and `call`, so the idle row that carries
 * Watch is not drawn in either of them while the ring still is. An indicator
 * the user can see and cannot act on is a worse bargain than no indicator at
 * all: it names something happening to them and withholds the means to end it.
 * So both of those phases carry a stop control of their own, on the same
 * `onWatch` the idle row presses.
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

  test("rides the composer while the user types", () => {
    const { container } = render(<CompanionSurface phase="typing" watching />);
    expect(stopOf(container)).not.toBeNull();
  });

  test("ends the session from the composer", () => {
    let presses = 0;
    const { container } = render(
      <CompanionSurface
        phase="typing"
        watching
        onWatch={() => {
          presses += 1;
        }}
      />,
    );
    fireEvent.click(required(container));
    expect(presses).toBe(1);
  });

  test("rides the call row too", () => {
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

  test("is absent from the composer with no session to stop", () => {
    const { container } = render(<CompanionSurface phase="typing" />);
    expect(stopOf(container)).toBeNull();
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
  // call or an open composer outranks the phase and the turn runs regardless.
  test("keeps that ring under a phase that outranks it", () => {
    const { container } = render(
      <CompanionSurface phase="typing" watchRetro="pending" />,
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
  /** `BASE_MAX_PILL_WIDTH` in `clients/macos/src/main/companion-window.ts`. */
  const CANVAS_CEILING = 360;

  test("holds for every phase", () => {
    const over = Object.entries(FALLBACK_WIDTHS).filter(
      ([, width]) => width > CANVAS_CEILING,
    );
    expect(over).toEqual([]);
  });

  /**
   * The call row is the one the stop control grew, so the bound above is only
   * worth anything if the entry it checks is the width of the row *with* the
   * control on it. Five controls is what that row draws, and the card cannot
   * grow the same way: it is a fixed width, and the composer's field gives up
   * the space out of its own.
   */
  test("sizes the call entry for the row that carries the stop control", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(FALLBACK_WIDTHS.call).toBeGreaterThan(FALLBACK_WIDTHS.hover);
  });

  test("leaves the card exactly at the ceiling it was already at", () => {
    expect(FALLBACK_WIDTHS.typing).toBe(CANVAS_CEILING);
  });
});

/**
 * The indicator outlives the phase.
 *
 * `watching` ranks below `typing` and `call`, so a session that is still
 * reading the screen is drawn under a phase that is not its own for as long as
 * the user is mid-sentence or on a call. Those are the phases where an
 * indicator derived from the phase would go dark, and going dark over a live
 * capture is the failure this surface exists to prevent.
 */
describe("the companion surface's capture indicator across phases", () => {
  test("survives the composer, which outranks the watching phase", () => {
    const { container } = render(<CompanionSurface phase="typing" watching />);
    expect(ringOf(container)).not.toBeNull();
  });

  test("survives a call, which outranks it too", () => {
    const { container } = render(
      <CompanionSurface phase="call" watching call={LISTENING_CALL} />,
    );
    expect(ringOf(container)).not.toBeNull();
  });

  test("follows the card's corner radius while the user types", () => {
    const { container } = render(<CompanionSurface phase="typing" watching />);
    expect(ringOf(container)?.className).toContain("rounded-[24px]");
  });

  test("is absent in the composer with no session running", () => {
    const { container } = render(<CompanionSurface phase="typing" />);
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
 * Growing leftward is two halves, and the surface is only in the right place
 * when both happen.
 *
 * Main positions the window by the *avatar's* centre and measures every later
 * drag, clamp and direction check from it. The renderer's half of that bargain
 * is to draw the avatar on the point the host aimed at: the surface anchors by
 * the edge the avatar is on, and the row the avatar sits in mirrors so the
 * avatar ends up against that edge.
 *
 * Anchoring without mirroring is the failure this covers. It draws the avatar
 * at the far end of the pill instead, up to a card's width from where main
 * believes it is, so the mascot teleports at the direction flip, the labels
 * sweep under a held pointer, and the point main hands presses to lands on a
 * control that refuses them. The surface reads as dead (JARVIS-1582).
 */
describe("the companion surface growing leftward", () => {
  /**
   * The row the avatar is on, found through the avatar rather than by its own
   * classes: it is the row's job to order the avatar, so the avatar is what
   * says which row it is.
   */
  const avatarRowOf = (container: HTMLElement): HTMLElement => {
    const avatar = container.querySelector<HTMLElement>(".size-11");
    if (!avatar?.parentElement) {
      throw new Error("Expected the avatar to render inside a row");
    }
    return avatar.parentElement;
  };

  test("mirrors the row the avatar is on", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="left" />,
    );
    expect(avatarRowOf(container).className).toContain("flex-row-reverse");
  });

  test("leaves that row alone growing the ordinary way", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="right" />,
    );
    expect(avatarRowOf(container).className).not.toContain("flex-row-reverse");
  });

  /**
   * The card is anchored by the same edge as the pill and is eight times the
   * avatar's width, so an unmirrored card puts the mascot further from where
   * main is measuring than any other state.
   */
  test("mirrors the card's row too", () => {
    const { container } = render(
      <CompanionSurface phase="typing" growth="left" />,
    );
    expect(avatarRowOf(container).className).toContain("flex-row-reverse");
  });

  /**
   * The other half. The row is `INNER_GAP` narrower than the pill, because that
   * gap is trailing space past the last control, so the row has to sit against
   * the anchored end and leave the slack at the other.
   */
  test("holds the row against the edge the pill is anchored by", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="left" />,
    );
    expect(surfaceOf(container).className).toContain("flex-row-reverse");
  });

  test("anchors the pill by its right edge", () => {
    const { container } = render(
      <CompanionSurface phase="hover" growth="left" />,
    );
    expect(surfaceOf(container).style.right).toBe("50%");
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
    for (const spotlight of ["talk", "type"] as const) {
      const { container } = render(
        <CompanionSurface phase="hover" spotlight={spotlight} />,
      );
      expect(named(container, "Talk").getAttribute("aria-pressed")).toBeNull();
      expect(named(container, "Type").getAttribute("aria-pressed")).toBeNull();
      cleanup();
    }
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
    const { container } = render(<CompanionSurface phase="typing" watching />);
    const stop = named(container, "Stop teaching");
    expect(stop.getAttribute("aria-pressed")).toBeNull();
  });
});

/**
 * The whole surface is a drag handle that happens to have words on it, so a
 * press and a sweep across it is a drag and never a text selection. Without
 * this, a drag that crosses the direction flip highlights "Talk" and "Type" on
 * the way past, and the selection it leaves behind arms the browser's own
 * text-drag against the next press (JARVIS-1582).
 */
describe("the companion surface's text selection", () => {
  test("is off across the surface", () => {
    const { container } = render(<CompanionSurface phase="hover" />);
    expect(surfaceOf(container).className).toContain("select-none");
  });

  test("is back on for a reply, which is prose to copy", () => {
    const { container } = render(
      <CompanionSurface
        phase="typing"
        turns={[
          { role: "assistant", text: "The 14:00 one moved to Thursday." },
        ]}
      />,
    );
    const turn = container.querySelector("p");
    expect(turn?.textContent).toBe("The 14:00 one moved to Thursday.");
    expect(turn?.closest(".select-text")).not.toBeNull();
  });

  test("is back on in the field, which needs a caret", () => {
    const { container } = render(
      <CompanionSurface phase="typing" growth="left" />,
    );
    expect(container.querySelector("input")?.className).toContain(
      "select-text",
    );
  });
});
