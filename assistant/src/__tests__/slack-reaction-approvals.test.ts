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
      source: "slack_reaction",
    });
  });

  test("maps thumbsup emoji to approve_once", () => {
    const result = reactionDecisionForEmoji("thumbsup");
    expect(result).toEqual({
      action: "approve_once",
      source: "slack_reaction",
    });
  });

  test("maps -1 emoji to reject", () => {
    const result = reactionDecisionForEmoji("-1");
    expect(result).toEqual({
      action: "reject",
      source: "slack_reaction",
    });
  });

  test("maps thumbsdown emoji to reject", () => {
    const result = reactionDecisionForEmoji("thumbsdown");
    expect(result).toEqual({
      action: "reject",
      source: "slack_reaction",
    });
  });

  test("alarm_clock emoji maps to approve_once (legacy compat)", () => {
    const result = reactionDecisionForEmoji("alarm_clock");
    expect(result).toEqual({
      action: "approve_once",
      source: "slack_reaction",
    });
  });

  test("white_check_mark emoji maps to approve_once (legacy compat)", () => {
    const result = reactionDecisionForEmoji("white_check_mark");
    expect(result).toEqual({
      action: "approve_once",
      source: "slack_reaction",
    });
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
