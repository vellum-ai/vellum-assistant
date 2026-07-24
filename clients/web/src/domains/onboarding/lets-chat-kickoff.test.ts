/**
 * Tests for the hidden "Let's chat" kickoff builder. The greeting turn is
 * forbidden from reading files, so the chosen assistant name must ride the
 * kickoff message itself — otherwise a slow or failed personality rewrite
 * leaves the model free to invent a name for its first words to the user.
 */

import { describe, expect, test } from "bun:test";

import { FIRST_RUN_SCOPES } from "./first-run-scope";
import { buildLetsChatKickoffMessage } from "./lets-chat-kickoff";

describe("buildLetsChatKickoffMessage", () => {
  test("carries the chosen assistant name into the kickoff", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("Your name is Quill — introduce yourself as Quill.");
    expect(msg).toContain("You're about to begin your first conversation.");
  });

  test("keeps the greeting short and forbids tools beyond the one ui_show", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("Keep it short!");
    expect(msg).toContain("don't use `recall`, don't read any files");
    expect(msg).toContain("no tool calls other than that single `ui_show`");
  });

  test("instructs one ui_show choice call with the three scope options", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("`ui_show` tool exactly once");
    expect(msg).toContain('"choice"');
    // Pin the exact option wire text: the data payloads are the contract the
    // click-telemetry consumer matches on, so they must stay byte-identical.
    for (const scope of FIRST_RUN_SCOPES) {
      expect(msg).toContain(
        `id \`scope_${scope}\`, \`data: {"firstRunScope": "${scope}"}\``,
      );
    }
  });

  test("keeps options title-only so the chips scan in a glance", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("six words or fewer");
    expect(msg).toContain("never set `description`");
    expect(msg).not.toContain("one-sentence `description`");
  });

  test("frames the options as starters, not a menu", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).toContain("conversation starters, not a menu");
    expect(msg).toContain("invite free-form answers");
  });

  test("drops the old closed-question instruction", () => {
    const msg = buildLetsChatKickoffMessage("Quill");
    expect(msg).not.toContain("five words or less");
    expect(msg).not.toContain("Never ask what they want to do");
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
