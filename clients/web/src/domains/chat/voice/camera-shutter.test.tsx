/**
 * Tests for `CameraShutter`, the control the voice room and the deep-link
 * capture overlay share.
 *
 * Load-bearing contracts: the design's outer geometry (an 84px ring measured
 * border-in, around a 64px core), which is what makes the shutter the one
 * target on the surface a thumb finds without looking; both capture modes; the
 * capture pulse, which is the ONLY thing that distinguishes a taken photo from
 * a dead button, since a viewfinder looks identical either side of a press; the
 * hold, whose whole job is to be told apart from the tap it ends with; the
 * presses that end without a release to end them, which must produce neither a
 * hold nor a photo; and the button surviving a `Tooltip` wrapper, which reaches
 * it through Radix's `asChild` slot rather than rendering its own element.
 */

import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { Tooltip } from "@vellumai/design-library";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import * as motionReact from "motion/react";

import {
  LONG_PRESS_MOVE_TOLERANCE_PX,
  LONG_PRESS_THRESHOLD_MS,
} from "@/hooks/use-long-press";
import { publish, __resetForTesting } from "@/lib/event-bus";

// `useReducedMotion` reads a cached media-query singleton, so a per-test
// `matchMedia` stub can't flip it. Override just that export and drive it
// through this toggle instead.
let reducedMotion = false;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const { CameraShutter } = await import("@/domains/chat/voice/camera-shutter");

afterEach(() => {
  cleanup();
  __resetForTesting();
  reducedMotion = false;
});

const noop = () => {};

const shutter = () => screen.getByTestId("s");
const core = () => screen.getByTestId("camera-shutter-core");
const pulse = () => screen.queryByTestId("camera-shutter-pulse");

/** The threshold, written out so a retune fails here first. */
const HOLD_MS = 500;

/**
 * Run a case on fake timers, so the threshold is crossed by advancing rather
 * than by waiting half a second per press.
 */
function withFakeTimers(body: (advanceBy: (ms: number) => void) => void): void {
  jest.useFakeTimers();
  try {
    body((ms) => {
      act(() => {
        jest.advanceTimersByTime(ms);
      });
    });
  } finally {
    jest.useRealTimers();
  }
}

/** Press the shutter, which is a pointer down and nothing else yet. */
function press(at: { x: number; y: number } = { x: 0, y: 0 }): void {
  fireEvent.pointerDown(shutter(), {
    button: 0,
    pointerId: 1,
    clientX: at.x,
    clientY: at.y,
  });
}

/**
 * Let go: the pointer comes up and the browser's click follows.
 *
 * Both halves, because the two are one act to the user and the suppression
 * under test lives between them.
 */
function release(): void {
  fireEvent.pointerUp(shutter(), { button: 0, pointerId: 1 });
  fireEvent.click(shutter());
}

describe("CameraShutter", () => {
  test("wears the design's outer geometry, ring measured border-in", () => {
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // 84 is the OUTER measure: the 2.5px ring eats into it rather than adding
    // to it, so the gap between ring and core is the design's 7.5px.
    expect(shutter().className).toContain("size-[84px]");
    expect(shutter().className).toContain("border-[2.5px]");
    expect(shutter().className).toContain("box-border");
    expect(core().className).toContain("size-16");
  });

  test("photo is white at rest; live is crimson and shrunk", () => {
    const { rerender } = render(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );

    expect(shutter().getAttribute("data-mode")).toBe("photo");
    expect(shutter().className).toContain("border-white");
    expect(core().className).toContain("bg-white");
    expect(core().className).toContain("scale-100");

    // The core shrinking to a crimson dot is the record-button language, and
    // it is what the room raises once the shutter has been held.
    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Stop live"
        testId="s"
        mode="live"
      />,
    );
    expect(shutter().getAttribute("data-mode")).toBe("live");
    expect(shutter().className).toContain("border-[var(--camera-accent)]");
    expect(core().className).toContain("bg-[var(--camera-accent)]");
    expect(core().className).toContain("scale-[0.58]");
  });

  test("a photo press fires the ring pulse, and fires it again per press", () => {
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // Nothing at rest: the keyframe starts from a shadow the ring does not
    // otherwise have, so mounting it would announce a photo nobody took.
    expect(pulse()).toBeNull();

    fireEvent.click(shutter());
    const first = pulse();
    expect(first).not.toBeNull();
    expect(first!.className).toContain("camera-shutter-pulse");

    // A remount, not a reused node: a CSS animation cannot be replayed by
    // leaving the element in place, and these presses come as fast as a thumb.
    fireEvent.click(shutter());
    expect(pulse()).not.toBe(first);
  });

  test("live's press stops the stream and does not pulse", () => {
    render(
      <CameraShutter
        onClick={noop}
        ariaLabel="Stop live"
        testId="s"
        mode="live"
      />,
    );

    fireEvent.click(shutter());
    // The ring morphing back to white already reports what happened. A capture
    // pulse would report a frame nobody took.
    expect(pulse()).toBeNull();
  });

  test("capturing dips the core and disabled dims the ring, separately", () => {
    const { rerender } = render(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );

    expect(core().className).not.toContain("opacity-70");
    expect(shutter().className).not.toContain("opacity-60");

    // The overlay disables the shutter before the viewfinder is ready, with
    // nothing being captured yet.
    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Take photo"
        testId="s"
        disabled
      />,
    );
    expect(core().className).not.toContain("opacity-70");
    expect(shutter().className).toContain("opacity-60");

    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Take photo"
        testId="s"
        capturing
        disabled
      />,
    );
    // The ring holds its size while the frame goes: the target under the
    // user's thumb must not move between one shot and the next.
    expect(core().className).toContain("opacity-70");
    expect(core().className).toContain("size-16");
  });

  test("reduced motion retimes the morph without dropping the pulse", () => {
    reducedMotion = true;
    render(<CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />);

    // The calm class swaps the overshoot for a linear 200ms and shortens the
    // pulse. It does not remove the pulse: that is feedback, not decoration.
    expect(shutter().className).toContain("camera-shutter-calm");
    fireEvent.click(shutter());
    expect(pulse()).not.toBeNull();
  });

  test("still takes the press when a Tooltip wraps it", () => {
    let presses = 0;
    render(
      <Tooltip content="Take photo">
        <CameraShutter
          onClick={() => {
            presses += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />
      </Tooltip>,
    );

    const button = shutter();
    expect(button.getAttribute("aria-label")).toBe("Take photo");

    fireEvent.click(button);
    expect(presses).toBe(1);
  });
});

/**
 * The hold, which is the half of the gesture no caller can own.
 *
 * A hold and the tap it ends with are one press to the browser, and the click
 * arrives in the same task as the release, so only the element taking the press
 * can tell them apart in time. Every case here is about that separation: what
 * counts as a hold, what cancels one, and what the release is allowed to do
 * afterwards.
 */
describe("CameraShutter: holding it", () => {
  test("holds to the app's own long-press numbers, not to numbers of its own", () => {
    // One definition for both gestures. A retune reaching only one of them
    // would make "held" mean two different lengths in one app, on whichever
    // surface the user happened to be.
    expect(LONG_PRESS_THRESHOLD_MS).toBe(HOLD_MS);
    // The wander cases below sit either side of this.
    expect(LONG_PRESS_MOVE_TOLERANCE_PX).toBe(10);
  });

  test("a held press fires onHold once, and never the tap", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      advanceBy(HOLD_MS);
      expect(holds).toBe(1);
      expect(taps).toBe(0);

      // The release is the same press. It must not also be read as a tap, and
      // holding past the threshold must not fire a second time.
      advanceBy(HOLD_MS);
      release();
      expect(holds).toBe(1);
      expect(taps).toBe(0);
    });
  });

  test("a hold fires no capture pulse", () => {
    withFakeTimers((advanceBy) => {
      render(
        <CameraShutter
          onClick={noop}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      advanceBy(HOLD_MS);
      release();

      // The pulse means "a frame just went". A hold takes none, so a ring
      // leaving the shutter here would report a photo nobody has.
      expect(pulse()).toBeNull();
    });
  });

  test("a press let go before the threshold is a tap", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      advanceBy(HOLD_MS - 1);
      release();

      expect(holds).toBe(0);
      expect(taps).toBe(1);
      expect(pulse()).not.toBeNull();
    });
  });

  test("a press that wanders past the tolerance never becomes a hold", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      render(
        <CameraShutter
          onClick={noop}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      // Inside the tolerance: a phone held at arm's length drifts, and that is
      // not the user aiming somewhere else.
      fireEvent.pointerMove(shutter(), {
        pointerId: 1,
        clientX: 6,
        clientY: 6,
      });
      advanceBy(HOLD_MS);
      expect(holds).toBe(1);

      cleanup();
      holds = 0;
      render(
        <CameraShutter
          onClick={noop}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      fireEvent.pointerMove(shutter(), {
        pointerId: 1,
        clientX: 12,
        clientY: 0,
      });
      advanceBy(HOLD_MS);
      expect(holds).toBe(0);
    });
  });

  test("a press that wanders takes no photo, and the next tap still does", () => {
    withFakeTimers(() => {
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // Past the tolerance and still over the button, which at 84px across is
      // most of the travel a thumb has. The release is a real click, and
      // answering it would upload a frame and persist a message for a gesture
      // this component has already given up on.
      press();
      fireEvent.pointerMove(shutter(), {
        pointerId: 1,
        clientX: 12,
        clientY: 0,
      });
      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();

      // Spent by that click rather than left raised: the press after it is an
      // ordinary tap and takes its photo.
      press();
      release();
      expect(taps).toBe(1);
      expect(pulse()).not.toBeNull();
    });
  });

  test("a cancelled pointer leaves no fired hold behind it either", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      let holds = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The hold runs all the way and enters Live, and the OS then takes the
      // pointer: no click comes, so the suppression the hold raised has
      // nothing of this press to be spent on.
      press();
      advanceBy(HOLD_MS);
      expect(holds).toBe(1);
      fireEvent.pointerCancel(shutter(), { pointerId: 1 });

      // The press that stops Live is the user's first attempt. A screen
      // reader's is a bare click with no press in front of it.
      fireEvent.click(shutter());
      expect(taps).toBe(1);
    });
  });

  test("a hold's own release is still the click that spends it", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The ordinary ending, which settles nothing early: this release does
      // produce a click, and that click is the one the hold suppresses.
      press();
      advanceBy(HOLD_MS);
      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();

      // Spent by it, so the bare activation after it lands.
      fireEvent.click(shutter());
      expect(taps).toBe(1);
    });
  });

  test("a cancelled pointer leaves no suppression behind it", () => {
    withFakeTimers(() => {
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The wander raises the suppression, and the browser then takes the
      // pointer back: a cancelled one fires no click, so this press has
      // nothing left of its own to spend the flag on.
      press();
      fireEvent.pointerMove(shutter(), {
        pointerId: 1,
        clientX: 12,
        clientY: 0,
      });
      fireEvent.pointerCancel(shutter(), { pointerId: 1 });

      // A screen reader and voice control both activate as a bare click with
      // no press in front of it, so nothing else would clear the flag first.
      fireEvent.click(shutter());
      expect(taps).toBe(1);
    });
  });

  test("the pointer being taken away or leaving cancels the hold", () => {
    for (const end of ["cancel", "leave"] as const) {
      withFakeTimers((advanceBy) => {
        let holds = 0;
        render(
          <CameraShutter
            onClick={noop}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        press();
        // A scroll or a system gesture claiming the touch, and a finger slid
        // off the button. Neither is a press the user is still making.
        if (end === "cancel") {
          fireEvent.pointerCancel(shutter(), { pointerId: 1 });
        } else {
          fireEvent.pointerLeave(shutter(), { pointerId: 1 });
        }
        advanceBy(HOLD_MS);

        expect(holds).toBe(0);
        cleanup();
      });
    }
  });

  test("a press that left the button takes no photo when it comes back", () => {
    withFakeTimers(() => {
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // Leaving gave the press up. The browser does not: a down and an up that
      // both landed on the button fire a click however far the pointer went in
      // between, so the release would otherwise take a photo the gesture had
      // already been let go of.
      press();
      fireEvent.pointerLeave(shutter(), { pointerId: 1 });
      fireEvent.pointerEnter(shutter(), { pointerId: 1 });
      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();

      press();
      release();
      expect(taps).toBe(1);
    });
  });

  test("Space holds; a short Space is still a tap, and Enter always is", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // Held. The button's own activation is suspended on the way down, so
      // the release adds no tap of its own.
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS);
      fireEvent.keyUp(shutter(), { key: " " });
      expect(holds).toBe(1);
      expect(taps).toBe(0);

      // Let go early: the press was a tap, and it is re-dispatched rather
      // than lost with the activation that was suspended for it.
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS - 1);
      fireEvent.keyUp(shutter(), { key: " " });
      expect(holds).toBe(1);
      expect(taps).toBe(1);

      // Enter fires its click on the way down, so there is no press to hold
      // and nothing here touches it.
      fireEvent.click(shutter());
      expect(holds).toBe(1);
      expect(taps).toBe(2);
    });
  });

  test("a hold withdrawn mid-press takes the press with it", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      const onClick = () => {
        taps += 1;
      };
      const { rerender } = render(
        <CameraShutter
          onClick={onClick}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The room withdraws the hold the moment Live stops being available to
      // enter. The armed timer holds the callback from the render that armed
      // it, so left running it would fire a hold the surface has already
      // decided against.
      press();
      advanceBy(HOLD_MS - 1);
      rerender(
        <CameraShutter onClick={onClick} ariaLabel="Take photo" testId="s" />,
      );
      advanceBy(HOLD_MS);
      expect(holds).toBe(0);

      // The release is not a photo either: the press was made for a second act
      // that no longer exists, not for the shutter.
      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();

      // And the suppression is spent, so the tap after it is an ordinary one.
      press();
      release();
      expect(taps).toBe(1);
    });
  });

  test("a re-render that still offers a hold leaves the press armed", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      const onHold = () => {
        holds += 1;
      };
      const { rerender } = render(
        <CameraShutter
          onClick={noop}
          onHold={onHold}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // A new function for the same offer, which is every render: the room
      // builds the handler inline. Reading the offer as an identity rather
      // than as presence would abandon every press the first time anything
      // else in the room changed.
      press();
      advanceBy(HOLD_MS - 1);
      rerender(
        <CameraShutter
          onClick={noop}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );
      advanceBy(1);

      expect(holds).toBe(1);
    });
  });

  test("a shutter disabled mid-press takes no hold from it", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      const onHold = () => {
        holds += 1;
      };
      const { rerender } = render(
        <CameraShutter
          onClick={noop}
          onHold={onHold}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The room holds the shutter off while a flip swaps the capture. A
      // button that has stopped taking presses has stopped taking this one.
      press();
      advanceBy(HOLD_MS - 1);
      rerender(
        <CameraShutter
          onClick={noop}
          onHold={onHold}
          ariaLabel="Take photo"
          testId="s"
          disabled
        />,
      );
      advanceBy(HOLD_MS);

      expect(holds).toBe(0);
    });
  });

  test("tabbing off the shutter ends the Space press it was holding", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <>
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />
          <button type="button" data-testid="elsewhere">
            Elsewhere
          </button>
        </>,
      );

      const elsewhere = screen.getByTestId("elsewhere");
      shutter().focus();
      fireEvent.keyDown(shutter(), { key: " " });
      // Focus moved inside the window, so the window keeps its own and the
      // page stays visible: nothing outside this button can tell. The `keyup`
      // that would end the press goes to whatever holds focus now.
      elsewhere.focus();
      advanceBy(HOLD_MS);
      expect(holds).toBe(0);

      fireEvent.keyUp(elsewhere, { key: " " });
      expect(holds).toBe(0);
      expect(taps).toBe(0);

      // Coming back is a new press, which behaves like any other.
      shutter().focus();
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS - 1);
      fireEvent.keyUp(shutter(), { key: " " });
      expect(holds).toBe(0);
      expect(taps).toBe(1);
      expect(pulse()).not.toBeNull();
    });
  });

  test("a pointer press whose focus is taken takes no photo on release", () => {
    withFakeTimers(() => {
      let taps = 0;
      render(
        <>
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />
          <button type="button" data-testid="elsewhere">
            Elsewhere
          </button>
        </>,
      );

      // A pointer press holds its own focus, so this is something taking it:
      // a dialog opening over the room, a programmatic move. The press is
      // aimed at a control that no longer has it, and the release is not a
      // photo any more than a wandering finger's is.
      shutter().focus();
      press();
      screen.getByTestId("elsewhere").focus();
      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();

      press();
      release();
      expect(taps).toBe(1);
    });
  });

  test("a window losing focus ends the Space press, its release included", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // No `keyup` reaches a button whose window is gone, so the threshold
      // would otherwise fire into a viewfinder nobody is watching, entering
      // Live on a press the user walked away from mid-way.
      fireEvent.keyDown(shutter(), { key: " " });
      fireEvent.blur(window);
      advanceBy(HOLD_MS);
      expect(holds).toBe(0);

      // The release lands on the way back. The press it belonged to is over, so
      // it is neither a hold nor the sub-threshold tap a short Space would
      // otherwise re-dispatch.
      fireEvent.keyUp(shutter(), { key: " " });
      expect(holds).toBe(0);
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();
    });
  });

  test("the app being put away ends an armed press and the click after it", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      press();
      // The bus's own edge, which is the one the iOS shell reports through. The
      // room gives Live up on it, so a hold firing afterwards would raise Live
      // again behind a backgrounded app, on a gesture made before it went away.
      publish("app.hidden", { signal: "visibility" });
      advanceBy(HOLD_MS);
      expect(holds).toBe(0);

      release();
      expect(taps).toBe(0);
      expect(pulse()).toBeNull();
    });
  });

  test("the tap after a keyboard hold still lands once the hold is withdrawn", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      const { rerender } = render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The room's shape: the hold enters Live, and Live has no second hold to
      // offer, so `onHold` goes away with the mode change.
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS);
      fireEvent.keyUp(shutter(), { key: " " });
      rerender(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          ariaLabel="Stop live"
          testId="s"
          mode="live"
        />,
      );

      // The press that leaves Live is a new press, so the suppression the
      // hold armed is spent rather than waiting to eat it: the keyboard path
      // produces no click of its own to spend it on.
      press();
      release();
      expect(taps).toBe(1);
    });
  });

  /**
   * A Space key held long enough to repeat.
   *
   * The activation is suspended per keydown, not per press, so a repeat let
   * through re-arms the very activation the first keydown was taken to
   * withhold. What the browser does with that re-armed activation on release
   * (fire a click) is not something happy-dom performs, so these pin the
   * prevention itself, which is the whole of the mechanism.
   */
  describe("a held Space that repeats", () => {
    /** Whether the button took the default: a cancelled event dispatches false. */
    function pressSpaceAgain(): boolean {
      return fireEvent.keyDown(shutter(), { key: " ", repeat: true });
    }

    test("keeps every repeat of the press it suspended, offer or no offer", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        fireEvent.keyDown(shutter(), { key: " " });
        // Still down, still under the threshold: the press is this button's
        // and its activation stays suspended.
        expect(pressSpaceAgain()).toBe(false);

        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        // The hold entered Live, so the room has no second hold to offer and
        // takes it back with the mode. The key is still down, and the repeats
        // still belong to the press that was suspended.
        rerender(
          <CameraShutter
            onClick={onClick}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );
        expect(pressSpaceAgain()).toBe(false);
        expect(pressSpaceAgain()).toBe(false);

        // Nothing the browser could fire on this release was left armed, so
        // the release of the hold does not stop the Live the hold started.
        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);
      });
    });

    test("rides through a key that is no part of it", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // A modifier struck mid-hold, which is neither an activation nor part
        // of this press. Settling the press for it would leave the threshold
        // armed with nothing recording what it belongs to.
        fireEvent.keyDown(shutter(), { key: " " });
        fireEvent.keyDown(shutter(), { key: "Shift" });
        expect(pressSpaceAgain()).toBe(false);

        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        rerender(
          <CameraShutter
            onClick={onClick}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );
        expect(pressSpaceAgain()).toBe(false);

        // The release of the hold does not stop the Live it started.
        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);
      });
    });

    test("is inert while a press it is not part of has the shutter", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // One gesture at a time, and the hold started first. Enter over the
        // top of it does nothing: its own activation is taken, so no photo,
        // and the press it landed on carries on to the threshold it was
        // counting to.
        fireEvent.keyDown(shutter(), { key: " " });
        advanceBy(HOLD_MS - 1);
        expect(fireEvent.keyDown(shutter(), { key: "Enter" })).toBe(false);

        advanceBy(1);
        expect(holds).toBe(1);
        expect(taps).toBe(0);
        expect(pulse()).toBeNull();

        // And the release of that hold is still its own, taking no photo.
        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);
      });
    });

    test("is the plain tap it always is with nothing underway", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // No press has the shutter, so Enter keeps the activation it fires on
        // the way down. The click stands in for the one the browser makes from
        // it, which happy-dom does not perform.
        expect(fireEvent.keyDown(shutter(), { key: "Enter" })).toBe(true);
        fireEvent.click(shutter());
        expect(taps).toBe(1);
        expect(pulse()).not.toBeNull();
      });
    });

    test("takes no photo from the keyboard press that entered Live", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        fireEvent.keyDown(shutter(), { key: " " });
        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        rerender(
          <CameraShutter
            onClick={onClick}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );

        // The key is still down, so the press still has the shutter and Enter
        // is inert. Its activation is taken rather than stopping the Live this
        // press has just entered.
        expect(fireEvent.keyDown(shutter(), { key: "Enter" })).toBe(false);
        expect(pressSpaceAgain()).toBe(false);
        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);

        // The press after it is the user asking for something, and it lands.
        expect(fireEvent.keyDown(shutter(), { key: "Enter" })).toBe(true);
        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("takes no photo from the pointer press that entered Live", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        press();
        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        rerender(
          <CameraShutter
            onClick={onClick}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );

        // The finger is still down, so this press still has the shutter and
        // keeps the suppression its release is answered by.
        expect(fireEvent.keyDown(shutter(), { key: "Enter" })).toBe(false);
        release();
        expect(taps).toBe(0);
        expect(pulse()).toBeNull();

        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("takes nothing from a press it did not suspend", () => {
      withFakeTimers(() => {
        render(
          <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
        );

        // No hold on offer, so nothing is armed and the native Space
        // activation is the shutter's only way to take a photo from a
        // keyboard. Preventing either of these would lose it.
        expect(fireEvent.keyDown(shutter(), { key: " " })).toBe(true);
        expect(pressSpaceAgain()).toBe(true);
      });
    });

    test("leaves the press after it free to stop Live", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        fireEvent.keyDown(shutter(), { key: " " });
        advanceBy(HOLD_MS);
        rerender(
          <CameraShutter
            onClick={onClick}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );
        expect(pressSpaceAgain()).toBe(false);
        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);

        // A deliberate tap afterwards is a press of its own, and Live has no
        // hold to offer, so it keeps its activation and stops the stream. The
        // click stands in for the one the browser fires from it, which
        // happy-dom does not perform.
        expect(fireEvent.keyDown(shutter(), { key: " " })).toBe(true);
        fireEvent.keyUp(shutter(), { key: " " });
        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });
  });

  test("a bare activation after a keyboard hold is not eaten by it", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      let holds = 0;
      const onClick = () => {
        taps += 1;
      };
      const { rerender } = render(
        <CameraShutter
          onClick={onClick}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The room's shape: the hold enters Live, Live has no second hold to
      // offer, and the release lands after the offer has gone.
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS);
      expect(holds).toBe(1);
      rerender(
        <CameraShutter
          onClick={onClick}
          ariaLabel="Stop live"
          testId="s"
          mode="live"
        />,
      );
      fireEvent.keyUp(shutter(), { key: " " });

      // What a screen reader and voice control dispatch: a click with no press
      // in front of it, so nothing of its own clears what the hold raised. The
      // press that stops Live is the user's first attempt, not their second.
      fireEvent.click(shutter());
      expect(taps).toBe(1);
    });
  });

  test("a pointer hold's own release is the click that spends it", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      const onClick = () => {
        taps += 1;
      };
      const { rerender } = render(
        <CameraShutter
          onClick={onClick}
          onHold={noop}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The same withdrawal, reached by a finger. This release does produce a
      // click, and that click is the one the hold was suppressing.
      press();
      advanceBy(HOLD_MS);
      rerender(
        <CameraShutter
          onClick={onClick}
          ariaLabel="Stop live"
          testId="s"
          mode="live"
        />,
      );
      release();
      expect(taps).toBe(0);

      // Spent by it, so a bare activation after it lands.
      fireEvent.click(shutter());
      expect(taps).toBe(1);
    });
  });

  /**
   * The presses that end where this button is not.
   *
   * Nothing is captured, so a finger lifted off the button and a key released
   * at whatever took focus are ends this element never sees, and none of them
   * produces a click for it to spend the suppression on. What is left raised
   * is spent on the next activation instead, and a screen reader's is a bare
   * click with no press in front of it to clear it first.
   */
  describe("ending somewhere else", () => {
    /** Lift the pointer off the button, where this element cannot hear it. */
    function releaseElsewhere(): void {
      fireEvent.pointerLeave(shutter(), { pointerId: 1 });
      fireEvent.pointerUp(document.body, { pointerId: 1 });
    }

    test("a wandering press released off the button eats no later activation", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        press();
        fireEvent.pointerMove(shutter(), {
          pointerId: 1,
          clientX: 12,
          clientY: 0,
        });
        releaseElsewhere();

        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("a fired hold released off the button eats no later activation", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        press();
        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        releaseElsewhere();

        // The press that stops Live is the user's first attempt.
        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("another finger lifting elsewhere spends nothing of this press", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // The wander gives this press up, and a second pointer lifts somewhere
        // else while the first is still down. The suppression belongs to the
        // pointer that made the press, so this one leaves it alone and the
        // release over the button is still refused.
        press();
        fireEvent.pointerMove(shutter(), {
          pointerId: 1,
          clientX: 12,
          clientY: 0,
        });
        fireEvent.pointerUp(document.body, { pointerId: 2 });
        release();
        expect(taps).toBe(0);

        press();
        release();
        expect(taps).toBe(1);
      });
    });

    test("a shutter disabled mid-press eats no later activation", () => {
      withFakeTimers(() => {
        let taps = 0;
        const onClick = () => {
          taps += 1;
        };
        const { rerender } = render(
          <CameraShutter
            onClick={onClick}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // A disabled button takes no click, and enabling it again replays
        // none, so the press it interrupted has nothing left to spend on.
        press();
        rerender(
          <CameraShutter
            onClick={onClick}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
            disabled
          />,
        );
        rerender(
          <CameraShutter
            onClick={onClick}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("a keyboard hold released at another element eats no later activation", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        render(
          <>
            <CameraShutter
              onClick={() => {
                taps += 1;
              }}
              onHold={() => {
                holds += 1;
              }}
              ariaLabel="Take photo"
              testId="s"
            />
            <button type="button" data-testid="elsewhere">
              Elsewhere
            </button>
          </>,
        );

        const elsewhere = screen.getByTestId("elsewhere");
        shutter().focus();
        fireEvent.keyDown(shutter(), { key: " " });
        advanceBy(HOLD_MS);
        expect(holds).toBe(1);

        // Focus moves with the key still down, so the release lands on
        // whatever took it and this button's own handler never runs.
        elsewhere.focus();
        fireEvent.keyUp(elsewhere, { key: " " });

        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("an unrelated key released elsewhere spends nothing", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // Space is the only key that arms anything here, so a Tab released
        // while a finger is mid-press is none of this button's business and
        // must not hand that press its photo back.
        press();
        fireEvent.pointerMove(shutter(), {
          pointerId: 1,
          clientX: 12,
          clientY: 0,
        });
        fireEvent.keyUp(document.body, { key: "Tab" });
        release();
        expect(taps).toBe(0);
      });
    });
  });

  /**
   * A second finger arriving while a press is underway.
   *
   * The press that started owns the shutter, and what it owns has to reach its
   * own release: the suppression that keeps its ending from turning into a
   * photo, and the pointer it is recorded under. A second touch that took
   * either would leave the first one's release to stop the Live its own hold
   * had just started.
   */
  describe("a second finger", () => {
    /** Land another pointer on the shutter, id of a finger that is not the press. */
    function secondFingerDown(): void {
      fireEvent.pointerDown(shutter(), {
        button: 0,
        pointerId: 2,
        clientX: 0,
        clientY: 0,
      });
    }

    function renderLiveCapableShutter(counts: {
      onTap: () => void;
      onHold: () => void;
    }) {
      return render(
        <CameraShutter
          onClick={counts.onTap}
          onHold={counts.onHold}
          ariaLabel="Take photo"
          testId="s"
        />,
      );
    }

    test("takes no photo from the press that entered Live", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        const onTap = () => {
          taps += 1;
        };
        const { rerender } = renderLiveCapableShutter({
          onTap,
          onHold: () => {
            holds += 1;
          },
        });

        press();
        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
        rerender(
          <CameraShutter
            onClick={onTap}
            ariaLabel="Stop live"
            testId="s"
            mode="live"
          />,
        );

        // The first finger is still down, so this one begins nothing.
        secondFingerDown();
        release();
        expect(taps).toBe(0);
        expect(pulse()).toBeNull();

        // The press after it is the user asking for something, and it lands.
        fireEvent.click(shutter());
        expect(taps).toBe(1);
      });
    });

    test("cannot wander, leave or lift the press out from under it", () => {
      withFakeTimers((advanceBy) => {
        let holds = 0;
        renderLiveCapableShutter({
          onTap: noop,
          onHold: () => {
            holds += 1;
          },
        });

        // Everything a finger that is not the press can do to the button. None
        // of it is this press's movement, this press's leaving, or this
        // press's release.
        press();
        secondFingerDown();
        fireEvent.pointerMove(shutter(), {
          pointerId: 2,
          clientX: 200,
          clientY: 200,
        });
        fireEvent.pointerLeave(shutter(), { pointerId: 2 });
        fireEvent.pointerUp(shutter(), { button: 0, pointerId: 2 });
        fireEvent.pointerCancel(shutter(), { pointerId: 2 });

        advanceBy(HOLD_MS);
        expect(holds).toBe(1);
      });
    });

    test("begins nothing while a Space press has the shutter", () => {
      withFakeTimers((advanceBy) => {
        let taps = 0;
        let holds = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={() => {
              holds += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // The key is down, so the shutter is taken. A finger landing on it
        // does not re-arm around itself and does not settle the press it found.
        fireEvent.keyDown(shutter(), { key: " " });
        advanceBy(HOLD_MS - 1);
        press();
        advanceBy(1);
        expect(holds).toBe(1);
        expect(taps).toBe(0);

        fireEvent.keyUp(shutter(), { key: " " });
        expect(taps).toBe(0);

        // And the pointer path is itself again on the press after it.
        press();
        release();
        expect(taps).toBe(1);
      });
    });

    test("is an ordinary press once the one before it has ended", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            onHold={noop}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // Sequential taps, and the second one is a different finger. Ownership
        // ends with the release, so nothing of the first is still holding it.
        press();
        release();
        expect(taps).toBe(1);

        secondFingerDown();
        fireEvent.pointerUp(shutter(), { button: 0, pointerId: 2 });
        fireEvent.click(shutter());
        expect(taps).toBe(2);
      });
    });

    test("leaves a plain photo shutter to the browser", () => {
      withFakeTimers(() => {
        let taps = 0;
        render(
          <CameraShutter
            onClick={() => {
              taps += 1;
            }}
            ariaLabel="Take photo"
            testId="s"
          />,
        );

        // Nothing arms with no hold on offer, so no press is recorded and no
        // finger owns anything. A second touch changes nothing about the one
        // click the browser makes from the primary pointer.
        press();
        secondFingerDown();
        fireEvent.pointerUp(shutter(), { button: 0, pointerId: 2 });
        release();

        expect(taps).toBe(1);
        expect(pulse()).not.toBeNull();
      });
    });
  });

  test("advertises the hold to a screen reader, and only when offered", () => {
    const { rerender } = render(
      <CameraShutter
        onClick={noop}
        onHold={noop}
        ariaLabel="Take photo"
        testId="s"
      />,
    );
    // A hold is invisible: there is no drawn affordance on the button itself.
    expect(shutter().getAttribute("aria-keyshortcuts")).toBe("Space");

    rerender(
      <CameraShutter onClick={noop} ariaLabel="Take photo" testId="s" />,
    );
    expect(shutter().getAttribute("aria-keyshortcuts")).toBeNull();
  });

  test("describes the gesture, and describes it alongside a caller's own", () => {
    const description = () => {
      const ids = shutter().getAttribute("aria-describedby");
      return ids
        ? ids
            .split(" ")
            .map((id) => document.getElementById(id)?.textContent)
            .join(" ")
        : null;
    };

    const { rerender } = render(
      <CameraShutter
        onClick={noop}
        onHold={noop}
        ariaLabel="Take a photo"
        description="Hold to start live video."
        testId="s"
      />,
    );

    // The name says what a press does; nothing but this says a hold does
    // anything, since the caption that carries it for the eye is aria-hidden.
    expect(description()).toBe("Hold to start live video.");
    // And it is a description, not a name: the label still stands alone.
    expect(shutter().getAttribute("aria-label")).toBe("Take a photo");

    rerender(
      <CameraShutter
        onClick={noop}
        ariaLabel="Stop live"
        description="Tap to stop live video."
        testId="s"
        mode="live"
      />,
    );
    expect(description()).toBe("Tap to stop live video.");

    // A `Tooltip` describes its trigger while it is open. Joined rather than
    // replaced, so opening one does not cost the gesture its only explanation.
    render(<p id="tip">Take a photo</p>);
    rerender(
      <CameraShutter
        onClick={noop}
        onHold={noop}
        ariaLabel="Take a photo"
        description="Hold to start live video."
        aria-describedby="tip"
        testId="s"
      />,
    );
    expect(description()).toBe("Hold to start live video. Take a photo");

    // Nothing to describe on a shutter whose only act is the one it is named
    // for, and no empty attribute left behind either.
    rerender(
      <CameraShutter onClick={noop} ariaLabel="Take a photo" testId="s" />,
    );
    expect(shutter().getAttribute("aria-describedby")).toBeNull();
  });

  test("a disabled shutter takes no hold", () => {
    withFakeTimers((advanceBy) => {
      let holds = 0;
      render(
        <CameraShutter
          onClick={noop}
          onHold={() => {
            holds += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
          disabled
        />,
      );

      press();
      advanceBy(HOLD_MS);
      fireEvent.keyDown(shutter(), { key: " " });
      advanceBy(HOLD_MS);

      // A shutter refusing presses refuses this one too: entering a streaming
      // mode from a control that cannot take a photo is the surface acting on
      // a press it just said it would not.
      expect(holds).toBe(0);
    });
  });

  test("with no hold on offer, presses behave exactly as before", () => {
    withFakeTimers((advanceBy) => {
      let taps = 0;
      render(
        <CameraShutter
          onClick={() => {
            taps += 1;
          }}
          ariaLabel="Take photo"
          testId="s"
        />,
      );

      // The gesture layer is inert, so a long press is a press: the deep-link
      // overlay's shutter offers no second act and must not lose a slow one.
      press();
      advanceBy(HOLD_MS * 2);
      release();

      expect(taps).toBe(1);
      expect(pulse()).not.toBeNull();

      // Nor a wandering one. Nothing is armed with no hold on offer, so there
      // is no press to give up on and the tolerance means nothing here.
      press();
      fireEvent.pointerMove(shutter(), {
        pointerId: 1,
        clientX: 40,
        clientY: 40,
      });
      release();

      expect(taps).toBe(2);
    });
  });
});
