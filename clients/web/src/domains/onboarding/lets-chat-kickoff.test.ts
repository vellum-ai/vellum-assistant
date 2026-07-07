/**
 * Tests for the hidden "Let's chat" kickoff builder. The greeting turn is
 * forbidden from reading files, so the chosen assistant name must ride the
 * kickoff message itself — otherwise a slow or failed personality rewrite
 * leaves the model free to invent a name for its first words to the user.
 */

import { describe, expect, test } from "bun:test";

import { buildLetsChatKickoffMessage } from "./lets-chat-kickoff";

describe("buildLetsChatKickoffMessage", () => {
  test("carries the chosen assistant name into the kickoff", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("Your name is Quill — introduce yourself as Quill.");
    expect(msg).toContain("You're about to begin your first conversation.");
    expect(msg).toContain("don't use `recall` or read any files");
  });

  test("omits the name line when no name was picked", () => {
    for (const name of [undefined, "", "   "]) {
      const msg = buildLetsChatKickoffMessage(name);
      expect(msg).not.toContain("Your name is");
      expect(msg).toContain("You're about to begin your first conversation.");
    }
  });

  test("trims the picked name", () => {
    const msg = buildLetsChatKickoffMessage("  Luna ");
    expect(msg).toContain("Your name is Luna — introduce yourself as Luna.");
  });
});
