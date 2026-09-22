import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_INTRO_BEATS,
  COMPANION_INTRO_CALL_CONTROLS,
  COMPANION_SIZES,
  companionBoxFor,
  companionCardSideFor,
  companionPadFor,
  companionScaleFor,
  companionIntroCallControlFor,
  type CompanionIntroBeat,
} from "@vellumai/ipc-contract";

import { INTRO_CALL_CHORD_KEYS } from "@/domains/chat/voice/live-voice/intro-call-chords";

import {
  CompanionIntro,
  INTRO_DEMO_SHORTCUTS,
  introSpotlight,
} from "./companion-intro";
import { CompanionSurface } from "./companion-surface";
import { introPermission } from "./companion-intro-fixtures";

afterEach(cleanup);

/** The introduction's card, which hangs off the avatar rather than the pill. */
const cardOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>("[role='group']");
  if (!found) {
    throw new Error("Expected the introduction's card to render");
  }
  return found;
};

/** How far a `calc(100% - Npx)` anchor holds its element off the canvas's bottom. */
const offCanvasBottom = (top: string): number => {
  const found = /^calc\(100% - ([\d.]+)px\)$/.exec(top);
  if (!found?.[1]) {
    throw new Error(`Expected an anchor off the canvas's bottom, got ${top}`);
  }
  return Number(found[1]);
};

/**
 * Where the introduction's card lands beside the surface it is describing.
 *
 * Every beat but the first holds the pill open, so the card and the pill are on
 * screen together. The card clears whichever of the centred creature and pill
 * reaches further toward it.
 */
describe("the companion introduction's clearance", () => {
  test("fits the larger card above the perched creature at every size pairing", () => {
    for (const avatarSize of COMPANION_SIZES) {
      for (const optionsSize of COMPANION_SIZES) {
        const avatarBox = companionBoxFor("avatar", avatarSize);
        const optionsBox = companionBoxFor("options", optionsSize);
        const view = render(
          <CompanionIntro
            beat="share"
            avatarBox={avatarBox}
            optionsBox={optionsBox}
          />,
        );
        const card = cardOf(view.container);
        const step = /^translateY\(calc\(-100% - ([\d.]+)px\)\)$/.exec(
          card.style.transform,
        );
        expect(step).not.toBeNull();
        const reach =
          (Number.parseFloat(card.style.height) + Number(step![1])) *
          companionScaleFor(optionsBox);
        expect(
          companionCardSideFor(avatarBox, optionsBox) + 0.001,
        ).toBeGreaterThanOrEqual(
          reach + companionPadFor(avatarBox, optionsBox),
        );
        view.unmount();
      }
    }
  });

  /**
   * A small creature inside a large pill, which is the pair that makes the pill
   * rather than the creature decide the card's clearance.
   */
  test("clears a pill that stands taller than the creature", () => {
    const { container: surface } = render(
      <CompanionSurface phase="hover" avatarBox={44} optionsBox={110} />,
    );
    const { container: intro } = render(
      <CompanionIntro beat="talk" avatarBox={44} optionsBox={110} />,
    );

    // The pill is the one element on the surface whose width animates. It
    // is centred on its line, so its top edge is half a row further off the
    // canvas's bottom edge than its anchor.
    const pill = surface.querySelector<HTMLElement>(".transition-\\[width\\]");
    if (!pill) {
      throw new Error("Expected the surface to render");
    }
    const pillTop =
      offCanvasBottom(pill.style.top) + COMPANION_BASE_AVATAR_BOX / 2;

    // How far the card is then stepped up off its own anchor.
    const card = cardOf(intro);
    const step = /^translateY\(calc\(-100% - ([\d.]+)px\)\)$/.exec(
      card.style.transform,
    );
    if (!step?.[1]) {
      throw new Error(
        `Expected a step up off the anchor, got ${card.style.transform}`,
      );
    }
    const cardBottom = offCanvasBottom(card.style.top) + Number(step[1]);

    expect(cardBottom).toBeGreaterThan(pillTop);
  });

  /**
   * How far the card steps off the creature is `companionLayoutFor`'s to say,
   * and `companion-layout.test.ts` states it. What the card owns is being
   * placed by that distance, converted into the units the wrapper's scale
   * leaves the canvas in.
   */
  test("places the card at the layout's step off the creature", () => {
    const { container } = render(
      <CompanionIntro
        beat="talk"
        cardGrowth="down"
        avatarBox={44}
        optionsBox={110}
      />,
    );

    // The 110-point pill reaches 55 points from the shared centre, then keeps
    // the 12-point gap. The wrapper's 2.5 scale leaves 26.8 authored units.
    expect(cardOf(container).style.transform).toBe("translateY(26.8px)");
  });

  /**
   * On the beats about one control the creature hops up onto that control,
   * which puts its whole box above the pill. A card placed for the pill alone
   * was drawn on top of it, and the walk is the part worth watching.
   *
   * Only those beats: the extra distance is most of a creature, and spending it
   * on the opening cards, which have nothing between them and the creature,
   * strands them up the canvas for a beat three presses away.
   */
  test("clears the perched creature on the beats that walk it", () => {
    const stepFor = (beat: CompanionIntroBeat): number => {
      const { container } = render(
        <CompanionIntro beat={beat} avatarBox={44} optionsBox={44} />,
      );
      const found = /translateY\(calc\(-100% - ([\d.]+)px\)\)/.exec(
        cardOf(container).style.transform,
      );
      if (!found?.[1]) {
        throw new Error(`Expected a step up on ${beat}`);
      }
      return Number(found[1]);
    };

    // A beat with nothing between the card and the creature clears their shared
    // 22-point half box and the 12-point gap.
    expect(
      COMPANION_INTRO_BEATS.filter(
        (beat) => introSpotlight(beat) === undefined,
      ).map(stepFor),
    ).toEqual([34, 34, 34, 34, 34]);

    // A beat that walks the creature clears where it stands: its own step off
    // the line (22 + 12), the hop over the bar (22), its half box (22), and
    // then the room left over its head (6).
    expect(
      COMPANION_INTRO_BEATS.filter(
        (beat) => introSpotlight(beat) !== undefined,
      ).map(stepFor),
    ).toEqual([84, 84, 84]);
  });
});

/**
 * The drawn keycap answers the key on the keyboard.
 *
 * The beat asks for a real key that this window never sees pressed, so the only
 * thing it has to go on is the count published from the window that owns the
 * binding. Green is that count moving and nothing else: a cap lit by a
 * permission the user granted months ago is a cap that is green before anybody
 * has pressed anything.
 */
describe("the introduction's keycap", () => {
  /** The cap, which is the one control on these beats labelled as the key. */
  const keycapOf = (container: HTMLElement): HTMLElement => {
    const found = container.querySelector<HTMLElement>("[aria-label='fn']");
    if (!found) {
      throw new Error("Expected the beat to draw the key");
    }
    return found;
  };

  /**
   * The cap's look after `taps` presses arrive on a beat that opened with
   * `before` already on the count.
   */
  const lookAfter = (taps: number, before = 0): string => {
    const { container, rerender } = render(
      <CompanionIntro beat="key" voiceKeyTaps={before} />,
    );
    rerender(<CompanionIntro beat="key" voiceKeyTaps={before + taps} />);
    return keycapOf(container).className;
  };

  test("is dark until the key is pressed", () => {
    expect(lookAfter(0)).toContain("bg-white/10");
    expect(lookAfter(0)).not.toContain("emerald");
  });

  test("lights on the first press and fills on the second", () => {
    const lit = lookAfter(1);
    const filled = lookAfter(2);

    expect(lit).toContain("emerald");
    expect(filled).toContain("emerald");
    expect(filled).not.toBe(lit);
  });

  /**
   * The count is a total for the life of the window that publishes it, so a
   * user who tapped the key before this beat came up has not answered this
   * card.
   */
  test("counts presses from the beat rather than from the window", () => {
    expect(lookAfter(0, 7)).toBe(lookAfter(0));
    expect(lookAfter(1, 7)).toBe(lookAfter(1));
  });

  /**
   * The count belongs to the app's window, which can reload while the beat is
   * still up: the run is main's and the surface holds it across that. The count
   * starts again at zero when it does, and the press after it has to land on
   * something rather than wait for the new count to climb past the old total.
   */
  test("follows the count back down when its window restarts", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="key" voiceKeyTaps={9} />,
    );
    rerender(<CompanionIntro beat="key" voiceKeyTaps={0} />);
    expect(keycapOf(container).className).not.toContain("emerald");

    rerender(<CompanionIntro beat="key" voiceKeyTaps={1} />);
    expect(keycapOf(container).className).toContain("emerald");
  });

  /** Walking on to the next beat asks again, so the cap starts again dark. */
  test("starts the next beat dark however many presses came before it", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="key" voiceKeyTaps={0} />,
    );
    rerender(<CompanionIntro beat="key" voiceKeyTaps={2} />);
    expect(keycapOf(container).className).toContain("emerald");

    rerender(<CompanionIntro beat="try" voiceKeyTaps={2} />);
    expect(keycapOf(container).className).not.toContain("emerald");
  });

  /**
   * A replayed introduction opens on the total the last one left.
   *
   * Nothing resets the count between runs, and nothing should: the window that
   * keeps it counts only while a run is staged, so the number a second run
   * inherits is exactly the presses the first one was answered with. The card
   * takes its own baseline as it mounts, which is what makes an inherited total
   * cost nothing.
   */
  test("lights the cap on a replayed run that starts from an old total", () => {
    // Where a first run of five presses left it.
    const { container, rerender } = render(
      <CompanionIntro beat="key" voiceKeyTaps={5} />,
    );
    expect(keycapOf(container).className).not.toContain("emerald");

    rerender(<CompanionIntro beat="key" voiceKeyTaps={6} />);
    const lit = keycapOf(container).className;
    rerender(<CompanionIntro beat="key" voiceKeyTaps={7} />);
    const filled = keycapOf(container).className;

    expect(lit).toContain("emerald");
    expect(filled).toContain("emerald");
    // The same two looks a first run gets, reached from a count that never
    // started at zero.
    expect(lit).toBe(lookAfter(1));
    expect(filled).toBe(lookAfter(2));
  });

  /**
   * The pointer's press is the one that is declined, and the words answer it.
   * A press of the real key afterwards is the user doing what was asked, so the
   * cap stops leaning away from a press it is lighting up for.
   */
  test("takes the scold down when the real key answers", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="key" voiceKeyTaps={0} />,
    );
    act(() => {
      keycapOf(container).click();
    });
    expect(keycapOf(container).className).toContain("scale-90");

    rerender(<CompanionIntro beat="key" voiceKeyTaps={1} />);
    expect(keycapOf(container).className).not.toContain("scale-90");
    expect(keycapOf(container).className).toContain("emerald");
  });
});

/**
 * The card draws a control for exactly the beats the contract says carry one.
 *
 * Three things act on that answer in three processes: main arms a chord, this
 * card draws a mark and a key, and the pill lights a button. The contract owns
 * the answer ({@link companionIntroCallControlFor}) and the compiler holds this
 * card's own tables to it, since a `ReactNode` cannot live in the contract.
 * These are the runtime half of that: a control the card cannot draw, or a card
 * drawing one the contract does not name, is a beat where the user is shown a
 * key nobody is listening for.
 */
describe("the introduction's call controls", () => {
  /** The caption under the chip, which every beat that draws a control has. */
  const shortcutCaptions = (container: HTMLElement): HTMLElement[] =>
    [...container.querySelectorAll<HTMLElement>("span")].filter(
      (span) => span.textContent === "Shortcut",
    );

  test("draws a mark and a key for every control the contract names", () => {
    for (const control of COMPANION_INTRO_CALL_CONTROLS) {
      const { container } = render(<CompanionIntro beat={control} />);

      expect(shortcutCaptions(container).length).toBe(1);
    }
  });

  test("draws one on no other beat", () => {
    for (const beat of COMPANION_INTRO_BEATS.filter(
      (each) => companionIntroCallControlFor(each) === undefined,
    )) {
      const { container } = render(<CompanionIntro beat={beat} />);

      expect(shortcutCaptions(container).length).toBe(0);
    }
  });

  /**
   * The key printed and the key armed are two statements about one chord, made
   * in different files: the card spells it for a reader (`⌥S`) and the binding
   * names it for the host (`s`). A card teaching a key the host does not take
   * is the failure this whole change exists to remove.
   */
  test("prints the key the binding actually arms", () => {
    for (const control of COMPANION_INTRO_CALL_CONTROLS) {
      const { container } = render(<CompanionIntro beat={control} />);
      const chip = [...container.querySelectorAll<HTMLElement>("span")].find(
        (span) => span.textContent?.startsWith("⌥"),
      );

      expect(chip?.textContent).toBe(
        `⌥${INTRO_CALL_CHORD_KEYS[control].toUpperCase()}`,
      );
    }
  });
});

/**
 * The shortcut chip answers the keys on the keyboard.
 *
 * The three call beats say the same thing twice, as a button on the pill and
 * as a chord, and the chord is armed for as long as the beat is up. The card
 * never sees the press: it is taken by the window that armed the binding and
 * told to this one as a count. Green is that count moving *for this beat's own
 * control*, because a press is addressed and the run walks between cards while
 * one is still crossing.
 */
describe("the introduction's shortcut chip", () => {
  /** The chip, which is the one thing on these beats that prints a chord. */
  const chipOf = (container: HTMLElement, shortcut: string): HTMLElement => {
    const found = [...container.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === shortcut,
    );
    if (!found) {
      throw new Error(`Expected the beat to draw ${shortcut}`);
    }
    return found;
  };

  test("is grey until the shortcut is pressed", () => {
    const { container } = render(
      <CompanionIntro beat="share" chordPresses={0} />,
    );

    expect(chipOf(container, INTRO_DEMO_SHORTCUTS.share).className).toContain(
      "bg-white/10",
    );
    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.share).className,
    ).not.toContain("emerald");
  });

  test("lights when its own shortcut is pressed", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="share" chordPresses={0} />,
    );

    rerender(
      <CompanionIntro beat="share" chordPresses={1} chordControl="share" />,
    );

    expect(chipOf(container, INTRO_DEMO_SHORTCUTS.share).className).toContain(
      "emerald",
    );
  });

  /**
   * A press made on the beat before, still crossing when the run walked on,
   * arrives as a step in the count that belongs to a card the user has left.
   * The control is what keeps it off this one.
   */
  test("stays grey when another control's shortcut is pressed", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="mute" chordPresses={0} />,
    );

    rerender(
      <CompanionIntro beat="mute" chordPresses={1} chordControl="share" />,
    );

    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.muteMicrophone).className,
    ).not.toContain("emerald");

    rerender(
      <CompanionIntro beat="mute" chordPresses={2} chordControl="mute" />,
    );

    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.muteMicrophone).className,
    ).toContain("emerald");
  });

  /**
   * The count is a total for the life of the window that publishes it, so a
   * chord pressed before this beat came up has not answered this card. The
   * beat that opened lit would be answering a press nobody made on it.
   */
  test("counts presses from the beat rather than from the window", () => {
    const { container } = render(
      <CompanionIntro beat="draw" chordPresses={4} chordControl="draw" />,
    );

    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.draw).className,
    ).not.toContain("emerald");
  });

  /** Walking on to the next beat asks again, so the next chip starts grey. */
  test("starts the next beat grey however many presses came before it", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="share" chordPresses={0} />,
    );
    rerender(
      <CompanionIntro beat="share" chordPresses={1} chordControl="share" />,
    );
    expect(chipOf(container, INTRO_DEMO_SHORTCUTS.share).className).toContain(
      "emerald",
    );

    rerender(
      <CompanionIntro beat="draw" chordPresses={1} chordControl="share" />,
    );
    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.draw).className,
    ).not.toContain("emerald");
  });

  /**
   * The count belongs to the app's window, which can reload while the beat is
   * still up: the run is main's and the surface holds it across that. The
   * press after the reload has to land on something rather than wait for the
   * new count to climb past the old total.
   */
  test("follows the count back down when its window restarts", () => {
    const { container, rerender } = render(
      <CompanionIntro beat="mute" chordPresses={9} chordControl="mute" />,
    );
    rerender(<CompanionIntro beat="mute" chordPresses={0} />);
    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.muteMicrophone).className,
    ).not.toContain("emerald");

    rerender(
      <CompanionIntro beat="mute" chordPresses={1} chordControl="mute" />,
    );
    expect(
      chipOf(container, INTRO_DEMO_SHORTCUTS.muteMicrophone).className,
    ).toContain("emerald");
  });
});

/**
 * The card is one box for the whole run.
 *
 * The beats say different amounts, and a card sized to each of them would
 * resize under the reader on every press and move the way on to a new place
 * each time. This is one run about one surface, not five panels.
 */
describe("the introduction's card box", () => {
  test("holds one size on every beat", () => {
    const boxes = COMPANION_INTRO_BEATS.map((beat) => {
      const { container } = render(<CompanionIntro beat={beat} />);
      const { width, height } = cardOf(container).style;
      return `${width}x${height}`;
    });

    expect(new Set(boxes).size).toBe(1);
  });

  /**
   * Back exists because prose gets reread, and it is held out of the first
   * beat, where a press on it could only do nothing.
   */
  test("offers a way back on every beat but the first", () => {
    const backOn = (beat: CompanionIntroBeat): boolean => {
      const { container } = render(
        <CompanionIntro beat={beat} onAdvance={() => undefined} />,
      );
      return [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Back",
      );
    };

    expect(backOn("idle")).toBe(false);
    expect(backOn("meet")).toBe(true);
    expect(backOn("try")).toBe(true);
  });

  test("a press on it asks main to walk the run back", () => {
    const asked: string[] = [];
    const { container } = render(
      <CompanionIntro
        beat="share"
        onAdvance={(action) => {
          asked.push(action);
        }}
      />,
    );
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    if (!back) {
      throw new Error("Expected a way back");
    }
    back.click();

    expect(asked).toEqual(["back"]);
  });
});

describe("permission setup in the coachmark", () => {
  test("keeps the card mounted during its initial permission check", () => {
    const view = render(
      <CompanionIntro
        beat="talk"
        permission={{
          kind: "microphone",
          state: { phase: "checking" },
          enable: () => {},
        }}
      />,
    );
    const card = view.getByRole("group");
    expect(view.getByText("Talk to me")).toBeTruthy();
    expect(view.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(view.queryByText("Enable microphone")).toBeNull();
    view.rerender(
      <CompanionIntro
        beat="talk"
        permission={introPermission("microphone", "granted")}
      />,
    );
    expect(view.getByText("Click me to start a conversation.")).toBeTruthy();
    expect(view.getByRole("group")).toBe(card);
    expect(view.queryByText("Enable microphone")).toBeNull();
  });

  test.each([
    ["talk", "microphone", "Enable microphone"],
    ["key", "inputMonitoring", "Open Settings"],
    ["share", "screen", "Enable screen sharing"],
  ] as const)(
    "offers explicit setup and skipping on %s",
    (beat, kind, label) => {
      const enable = mock(() => {});
      const advance = mock((_action: string) => {});
      const view = render(
        <CompanionIntro
          beat={beat}
          onAdvance={advance}
          permission={{ ...introPermission(kind), enable }}
        />,
      );
      expect(enable).not.toHaveBeenCalled();
      fireEvent.click(view.getByRole("button", { name: label }));
      expect(enable).toHaveBeenCalledTimes(1);
      expect(advance).not.toHaveBeenCalled();
      fireEvent.click(view.getByRole("button", { name: "Skip for now" }));
      expect(advance).toHaveBeenCalledWith("next");
    },
  );
  test("keeps the final step dismissible when the microphone is denied", () => {
    const advance = mock((_action: string) => {});
    const view = render(
      <CompanionIntro
        beat="try"
        onAdvance={advance}
        permission={introPermission("microphone", "denied")}
      />,
    );
    expect(view.getByRole("button", { name: "Open Settings" })).toBeTruthy();
    expect(view.queryByText("Say hello and I’ll answer out loud.")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Got it" }));
    expect(advance).toHaveBeenCalledWith("next");
  });
});
