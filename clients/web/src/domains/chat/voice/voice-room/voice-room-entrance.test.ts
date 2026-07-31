/**
 * Tests for the room's entrance choreography.
 *
 * The behaviour being pinned is "presented means nothing introduces itself":
 * the sheet already has an entrance of its own, so a look that also animates in
 * gives the user two competing arrivals. `initial === false` is how a Motion
 * element declares it starts at rest, so that is what these assert on.
 */

import { describe, expect, it } from "bun:test";

import type { VoiceRoomVariant } from "./voice-room";

import {
  bodyGrowMotion,
  colorFillMotion,
  eyesEntranceMotion,
  resolveVoiceRoomChoreography,
  resolveVoiceRoomEntrance,
  voidAvatarMotion,
  withReducedMotion,
} from "./voice-room-entrance";

const VARIANTS: readonly VoiceRoomVariant[] = [
  "fullscreen",
  "content",
  "sheet",
];

const BODY = { startScale: 0.2, startX: -120, startY: 80 };
const EYES = { startX: -120, startY: 80, dipY: 12 };

describe("resolveVoiceRoomEntrance", () => {
  it("presents the sheet: its slide-up is the entrance", () => {
    expect(resolveVoiceRoomEntrance("sheet", false)).toBe("presented");
  });

  it("grows the variants whose box has no entrance of its own", () => {
    expect(resolveVoiceRoomEntrance("content", false)).toBe("grow");
    expect(resolveVoiceRoomEntrance("fullscreen", false)).toBe("grow");
  });

  for (const variant of VARIANTS) {
    it(`presents ${variant} under reduced motion`, () => {
      expect(resolveVoiceRoomEntrance(variant, true)).toBe("presented");
    });
  }
});

describe("withReducedMotion", () => {
  it("overrides a grow the caller asked for", () => {
    expect(withReducedMotion("grow", true)).toBe("presented");
  });

  it("leaves the mode alone otherwise", () => {
    expect(withReducedMotion("grow", false)).toBe("grow");
    expect(withReducedMotion("presented", false)).toBe("presented");
  });
});

describe("presented layers start at rest", () => {
  it("paints the colour fill with no fade", () => {
    expect(colorFillMotion("presented").initial).toBe(false);
  });

  it("leaves the body silhouette covering the room", () => {
    expect(bodyGrowMotion("presented", BODY).initial).toBe(false);
  });

  it("leaves the void look's avatar centred", () => {
    expect(voidAvatarMotion("presented").initial).toBe(false);
  });

  it("holds the eyes at their resting pose", () => {
    const eyes = eyesEntranceMotion("presented", EYES, false);
    expect(eyes.initial).toBe(false);
    expect(eyes.animate).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("gives the look no exit of its own, the surface carries it off", () => {
    expect(colorFillMotion("presented").exit).toBeUndefined();
    expect(bodyGrowMotion("presented", BODY).exit).toBeUndefined();
    expect(voidAvatarMotion("presented").exit).toBeUndefined();
    expect(eyesEntranceMotion("presented", EYES, false).exit).toBeUndefined();
  });
});

describe("the grow travels from the entry origin and back to it", () => {
  it("starts the body at the tapped point, scaled down", () => {
    expect(bodyGrowMotion("grow", BODY).initial).toEqual({
      scale: BODY.startScale,
      x: BODY.startX,
      y: BODY.startY,
    });
  });

  it("collapses the body back to where it came from", () => {
    expect(bodyGrowMotion("grow", BODY).exit).toMatchObject({
      scale: BODY.startScale,
      x: BODY.startX,
      y: BODY.startY,
    });
  });

  it("collapses the eyes back to the same point", () => {
    expect(eyesEntranceMotion("grow", EYES, true).exit).toMatchObject({
      x: EYES.startX,
      y: EYES.startY,
      opacity: 0,
    });
  });
});

describe("the eyes stop handing Motion keyframes once the entrance lands", () => {
  // A keyframe array restarts whenever Motion is handed a new one, and the eyes
  // re-render on every session-state change. Left in place they would replay
  // part of the entrance mid-session, the lurch this latch exists to stop.
  it("plays keyframe arrays while the entrance is running", () => {
    const animate = eyesEntranceMotion("grow", EYES, false).animate as Record<
      string,
      unknown
    >;
    expect(animate.x).toEqual([EYES.startX, 0, 0]);
    expect(animate.y).toEqual([EYES.startY, EYES.dipY, 0]);
  });

  it("settles to a static target that re-renders can repeat", () => {
    expect(eyesEntranceMotion("grow", EYES, true).animate).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });
});

describe("resolveVoiceRoomChoreography", () => {
  it("hands the sheet's travel to its chrome, not to the room's box", () => {
    const { shell, sheetChrome } = resolveVoiceRoomChoreography("sheet", false);
    // The room's box holds still: sliding it inside the sheet would expose the
    // page behind the look.
    expect(shell.initial).toBe(false);
    expect(shell.exit).toBeUndefined();
    expect(sheetChrome?.exit).toMatchObject({ y: "100%" });
  });

  it("keeps the chrome from fighting Radix's slide-up on open", () => {
    const { sheetChrome } = resolveVoiceRoomChoreography("sheet", false);
    expect(sheetChrome?.initial).toBe(false);
  });

  it("drops the sheet's travel under reduced motion rather than shortening it", () => {
    const { sheetChrome } = resolveVoiceRoomChoreography("sheet", true);
    expect(sheetChrome?.exit).toEqual({
      opacity: 0,
      transition: { duration: 0 },
    });
  });

  it("gives the variants with no chrome none to animate", () => {
    for (const variant of ["fullscreen", "content"] as const) {
      expect(
        resolveVoiceRoomChoreography(variant, false).sheetChrome,
      ).toBeNull();
    }
  });

  it("fades the room's own box on the variants that own their exit", () => {
    const { shell } = resolveVoiceRoomChoreography("content", false);
    expect(shell.initial).toEqual({ opacity: 0 });
    expect(shell.exit).toEqual({ opacity: 0 });
  });
});
