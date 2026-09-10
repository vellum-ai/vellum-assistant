import { describe, expect, test } from "bun:test";
import { slackEmojiCharacter } from "./emoji.js";

/** Presentation selectors do not change what a person sees. */
const glyph = (s: string | undefined) => s?.replace(/️/g, "");

describe("slackEmojiCharacter", () => {
  test("resolves Slack's names, every short name of an emoji alike", () => {
    expect(glyph(slackEmojiCharacter("tada"))).toBe("🎉");
    expect(glyph(slackEmojiCharacter("+1"))).toBe("👍");
    expect(slackEmojiCharacter("thumbsup")).toBe(slackEmojiCharacter("+1"));
  });

  test("resolves names GitHub's list lacks or spells to a different glyph", () => {
    expect(glyph(slackEmojiCharacter("flag-nz"))).toBe("🇳🇿");
    expect(glyph(slackEmojiCharacter("umbrella"))).toBe("☂");
  });

  test("resolves a skin tone suffix to the toned variant", () => {
    expect(glyph(slackEmojiCharacter("thumbsup::skin-tone-3"))).toBe("👍🏼");
  });

  test("a same-tone composite repeats the tone for each person", () => {
    expect(
      glyph(slackEmojiCharacter("people_holding_hands::skin-tone-3")),
    ).toBe(glyph("🧑🏼‍🤝‍🧑🏼"));
  });

  test("places the tone inside a multi-person sequence", () => {
    expect(glyph(slackEmojiCharacter("woman-raising-hand::skin-tone-2"))).toBe(
      glyph("🙋🏻‍♀️"),
    );
  });

  test("keeps the base character for an emoji with no tone variants", () => {
    expect(glyph(slackEmojiCharacter("tada::skin-tone-4"))).toBe("🎉");
  });

  test("a name outside Slack's standard list is a workspace emoji: no character", () => {
    expect(slackEmojiCharacter("blob_wave")).toBeUndefined();
    expect(slackEmojiCharacter("blob_wave::skin-tone-2")).toBeUndefined();
  });
});
