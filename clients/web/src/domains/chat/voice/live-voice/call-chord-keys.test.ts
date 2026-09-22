/**
 * The caption's spelling of each chord comes from the same constants the
 * binding is armed with, so what the pill promises and what the host listens
 * for cannot drift apart.
 */

import { describe, expect, test } from "bun:test";

import {
  CALL_DRAW_KEY,
  CALL_MUTE_ASSISTANT_KEY,
  CALL_MUTE_MIC_KEY,
  CALL_SHARE_KEY,
  callChordHints,
} from "@/domains/chat/voice/live-voice/call-chord-keys";

describe("the call chords' captions", () => {
  /**
   * The platform is named rather than detected: the test DOM reports whichever
   * machine runs it, and the spelling under test is the Mac's.
   */
  test("spell each key under Option, in the Mac's glyphs", () => {
    expect(callChordHints("mac")).toEqual({
      share: `⌥${CALL_SHARE_KEY.toUpperCase()}`,
      draw: `⌥${CALL_DRAW_KEY.toUpperCase()}`,
      muteMicrophone: `⌥${CALL_MUTE_MIC_KEY.toUpperCase()}`,
      muteAssistant: `⌥${CALL_MUTE_ASSISTANT_KEY.toUpperCase()}`,
    });
  });

  /** The same keys, in the words a host without the glyphs would write. */
  test("spell them as Alt on a host that writes modifiers as words", () => {
    expect(callChordHints("windows").share).toBe(
      `Alt+${CALL_SHARE_KEY.toUpperCase()}`,
    );
  });

  /** The helper matches a press by the character on its cap, and caps are single characters. */
  test("names single keycap characters", () => {
    for (const key of [
      CALL_SHARE_KEY,
      CALL_DRAW_KEY,
      CALL_MUTE_MIC_KEY,
      CALL_MUTE_ASSISTANT_KEY,
    ]) {
      expect(key).toHaveLength(1);
    }
  });
});
