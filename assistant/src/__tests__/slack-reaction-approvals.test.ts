import { describe, expect, test } from "bun:test";

import { reactionDecisionForEmoji } from "../runtime/routes/channel-route-shared.js";

// =============================================================================
// reactionDecisionForEmoji
// =============================================================================

describe("reactionDecisionForEmoji", () => {
  test("maps +1 emoji to approve_once", () => {
    const result = reactionDecisionForEmoji("+1");
    expect(result).toEqual({
      action: "approve_once",
      source: "reaction",
    });
  });

  test("maps thumbsup emoji to approve_once", () => {
    const result = reactionDecisionForEmoji("thumbsup");
    expect(result).toEqual({
      action: "approve_once",
      source: "reaction",
    });
  });

  test("maps -1 emoji to reject", () => {
    const result = reactionDecisionForEmoji("-1");
    expect(result).toEqual({
      action: "reject",
      source: "reaction",
    });
  });

  test("maps thumbsdown emoji to reject", () => {
    const result = reactionDecisionForEmoji("thumbsdown");
    expect(result).toEqual({
      action: "reject",
      source: "reaction",
    });
  });

  test("alarm_clock emoji maps to approve_once (legacy compat)", () => {
    const result = reactionDecisionForEmoji("alarm_clock");
    expect(result).toEqual({
      action: "approve_once",
      source: "reaction",
    });
  });

  test("white_check_mark emoji maps to approve_once (legacy compat)", () => {
    const result = reactionDecisionForEmoji("white_check_mark");
    expect(result).toEqual({
      action: "approve_once",
      source: "reaction",
    });
  });

  test("unicode vocabulary: thumbs up, check mark, and alarm clock approve", () => {
    for (const emoji of ["\u{1F44D}", "\u2705", "\u23F0"]) {
      expect(reactionDecisionForEmoji(emoji)).toEqual({
        action: "approve_once",
        source: "reaction",
      });
    }
  });

  test("unicode vocabulary: thumbs down rejects", () => {
    expect(reactionDecisionForEmoji("\u{1F44E}")).toEqual({
      action: "reject",
      source: "reaction",
    });
  });

  test("a Discord custom emoji in mention form never resolves a decision", () => {
    // A guild custom emoji can be named after a Slack decision word; the
    // gateway forwards it as its mention form, which must stay unmapped.
    expect(
      reactionDecisionForEmoji("<:white_check_mark:999888777>"),
    ).toBeNull();
    expect(reactionDecisionForEmoji("<:thumbsup:999888777>")).toBeNull();
  });

  test("returns null for unknown emoji", () => {
    const result = reactionDecisionForEmoji("tada");
    expect(result).toBeNull();
  });

  test("returns null for an unmapped emoji", () => {
    const result = reactionDecisionForEmoji("eyes");
    expect(result).toBeNull();
  });

  test("returns null for an empty emoji name", () => {
    const result = reactionDecisionForEmoji("");
    expect(result).toBeNull();
  });
});
