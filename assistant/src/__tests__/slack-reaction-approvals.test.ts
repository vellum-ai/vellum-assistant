import { describe, expect, test } from "bun:test";

import { parseReactionCallbackData } from "../runtime/routes/channel-route-shared.js";

// =============================================================================
// parseReactionCallbackData
// =============================================================================

describe("parseReactionCallbackData", () => {
  test("maps +1 emoji to approve_once", () => {
    const result = parseReactionCallbackData("reaction:+1");
    expect(result).toEqual({
      action: "approve_once",
      source: "slack_reaction",
    });
  });

  test("maps thumbsup emoji to approve_once", () => {
    const result = parseReactionCallbackData("reaction:thumbsup");
    expect(result).toEqual({
      action: "approve_once",
      source: "slack_reaction",
    });
  });

  test("maps -1 emoji to reject", () => {
    const result = parseReactionCallbackData("reaction:-1");
    expect(result).toEqual({
      action: "reject",
      source: "slack_reaction",
    });
  });

  test("maps thumbsdown emoji to reject", () => {
    const result = parseReactionCallbackData("reaction:thumbsdown");
    expect(result).toEqual({
      action: "reject",
      source: "slack_reaction",
    });
  });

  test("maps alarm_clock emoji to approve_10m", () => {
    const result = parseReactionCallbackData("reaction:alarm_clock");
    expect(result).toEqual({
      action: "approve_10m",
      source: "slack_reaction",
    });
  });

  test("maps white_check_mark emoji to approve_always", () => {
    const result = parseReactionCallbackData("reaction:white_check_mark");
    expect(result).toEqual({
      action: "approve_always",
      source: "slack_reaction",
    });
  });

  test("returns null for unknown emoji", () => {
    const result = parseReactionCallbackData("reaction:tada");
    expect(result).toBeNull();
  });

  test("returns null for empty emoji name", () => {
    const result = parseReactionCallbackData("reaction:");
    expect(result).toBeNull();
  });

  test("returns null for non-reaction callback data", () => {
    const result = parseReactionCallbackData("apr:req-1:approve_once");
    expect(result).toBeNull();
  });

  test("returns null for plain text", () => {
    const result = parseReactionCallbackData("yes");
    expect(result).toBeNull();
  });
});
