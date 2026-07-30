/**
 * Tests for {@link toRoomLocal}, the viewport to room-local conversion the inset
 * voice room depends on.
 *
 * This is the arithmetic that stops the room's entrance from growing out of the
 * wrong place. The composer captures the entry origin in viewport coordinates
 * (a `getBoundingClientRect()` on the avatar the user tapped) and the room's
 * look positions everything against its own box, so the two only agree once the
 * point is shifted by the panel's offset. The offset is exactly the chrome the
 * panel sits inside: skip the conversion and the entrance is off by the header
 * and sidenav. It is zero for the fullscreen room, where the two coordinate
 * spaces coincide.
 */

import { describe, expect, test } from "bun:test";

import { toRoomLocal, type RoomBox } from "./use-room-box";

/** A panel inset by a 56px-tall title bar and a 260px sidenav. */
const PANEL: RoomBox = { w: 1000, h: 700, left: 260, top: 56 };
/** The fullscreen (mobile) room: the panel IS the viewport. */
const FULLSCREEN: RoomBox = { w: 390, h: 844, left: 0, top: 0 };

describe("toRoomLocal", () => {
  test("shifts a viewport point by the panel's offset", () => {
    expect(toRoomLocal({ x: 300, y: 100 }, PANEL)).toEqual({ x: 40, y: 44 });
  });

  test("is a no-op for a zero-offset (fullscreen) room", () => {
    expect(toRoomLocal({ x: 195, y: 400 }, FULLSCREEN)).toEqual({
      x: 195,
      y: 400,
    });
  });

  test("keeps a point that lands outside the panel outside it", () => {
    // A tap in the sidenav, left of the room's left edge. Clamping this into
    // the panel would make the entrance grow from the panel's edge instead of
    // flying in from where the user actually tapped.
    expect(toRoomLocal({ x: 120, y: 300 }, PANEL)).toEqual({ x: -140, y: 244 });
  });

  test("returns null when either input is missing", () => {
    // No origin was captured (a keyboard-started session), or the box has not
    // been measured yet. The look falls back to its own centered origin.
    expect(toRoomLocal(null, PANEL)).toBeNull();
    expect(toRoomLocal({ x: 300, y: 100 }, null)).toBeNull();
    expect(toRoomLocal(null, null)).toBeNull();
  });
});
