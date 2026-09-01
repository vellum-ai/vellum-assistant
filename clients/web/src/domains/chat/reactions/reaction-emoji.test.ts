import { describe, expect, test } from "bun:test";

import {
  isUnresolvedEmojiDisplay,
  reactionEmojiDisplay,
} from "./reaction-emoji";

describe("reactionEmojiDisplay", () => {
  test("resolves a standard shortcode synchronously", () => {
    // Synchronously is the point: no hook, no await, no lazy chunk. A
    // transcript's reactions must not paint as text and swap later.
    expect(reactionEmojiDisplay("tada")).toBe("🎉");
    expect(reactionEmojiDisplay("+1")).toBe("👍");
  });

  test("passes a unicode glyph through untouched", () => {
    expect(reactionEmojiDisplay("🎉")).toBe("🎉");
  });

  test("a Discord custom emoji keeps its guild identity", () => {
    // `heart` exists in the render map, so a lookup here would swap a
    // guild's own emoji for the standard one. The name must survive.
    expect(reactionEmojiDisplay("<:heart:123456789>")).toBe(":heart:");
    expect(reactionEmojiDisplay("<:vex:987654321>")).toBe(":vex:");
    expect(reactionEmojiDisplay("heart")).not.toBe(":heart:");
  });

  test("an animated Discord custom emoji is treated the same", () => {
    expect(reactionEmojiDisplay("<a:party_parrot:42>")).toBe(":party_parrot:");
  });

  test("an unknown shortcode reads as its colon form", () => {
    // A Slack workspace's own custom emoji lands here: this build cannot
    // know the name, and the colon form is the honest answer.
    expect(reactionEmojiDisplay("vellum_party")).toBe(":vellum_party:");
  });
});

describe("isUnresolvedEmojiDisplay", () => {
  test("separates an unresolved name from a glyph", () => {
    expect(isUnresolvedEmojiDisplay(reactionEmojiDisplay("vellum_party"))).toBe(
      true,
    );
    expect(isUnresolvedEmojiDisplay(reactionEmojiDisplay("<:vex:1>"))).toBe(
      true,
    );
    expect(isUnresolvedEmojiDisplay(reactionEmojiDisplay("tada"))).toBe(false);
    expect(isUnresolvedEmojiDisplay(reactionEmojiDisplay("🎉"))).toBe(false);
  });
});
