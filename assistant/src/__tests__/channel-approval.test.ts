import { describe, expect, test } from "bun:test";

import type { ApprovalAction } from "../runtime/channel-approval-types.js";
import {
  parseCallbackData,
  parseQuestionCallbackData,
} from "../runtime/routes/channel-route-shared.js";

// ═══════════════════════════════════════════════════════════════════════════
// Callback data parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCallbackData", () => {
  test.each([
    ["apr:req-123:approve_once", "approve_once"],
    ["apr:req-123:reject", "reject"],
  ] as const)('parses "%s" as action "%s"', (data, expectedAction) => {
    const result = parseCallbackData(data);
    expect(result).not.toBeNull();
    expect(result!.action).toBe(expectedAction);
    expect(result!.requestId).toBe("req-123");
    expect(result!.source).toBe("telegram_button");
  });

  test.each<[string, string]>([
    ["apr:req-123:approve_10m", "approve_once"],
    ["apr:req-123:approve_conversation", "approve_once"],
    ["apr:req-123:approve_always", "approve_once"],
  ])(
    'maps legacy action "%s" to %s (backward compat)',
    (data, expectedAction) => {
      const result = parseCallbackData(data);
      expect(result).not.toBeNull();
      expect(result!.action).toBe(expectedAction as ApprovalAction);
      expect(result!.requestId).toBe("req-123");
    },
  );

  test("parses slack source channel", () => {
    const result = parseCallbackData("apr:req-789:approve_once", "slack");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
    expect(result!.requestId).toBe("req-789");
    expect(result!.source).toBe("slack_button");
  });

  test("returns null for unknown action", () => {
    expect(parseCallbackData("apr:req-123:unknown_action")).toBeNull();
  });

  test("returns null for missing prefix", () => {
    expect(parseCallbackData("xyz:req-123:approve_once")).toBeNull();
  });

  test("returns null for incomplete data", () => {
    expect(parseCallbackData("apr:req-123")).toBeNull();
  });

  test("returns null for empty requestId", () => {
    expect(parseCallbackData("apr::approve_once")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Question wizard callback data parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseQuestionCallbackData", () => {
  test("parses an option-index tap", () => {
    expect(parseQuestionCallbackData("qst:req-1:q1:0")).toEqual({
      requestId: "req-1",
      questionId: "q1",
      selection: 0,
    });
    expect(parseQuestionCallbackData("qst:req-1:q2:3")).toEqual({
      requestId: "req-1",
      questionId: "q2",
      selection: 3,
    });
  });

  test("parses a skip tap", () => {
    expect(parseQuestionCallbackData("qst:req-1:q1:skip")).toEqual({
      requestId: "req-1",
      questionId: "q1",
      selection: "skip",
    });
  });

  test("returns null for a non-question prefix", () => {
    expect(parseQuestionCallbackData("apr:req-1:q1:0")).toBeNull();
  });

  test("returns null for the wrong number of fields", () => {
    expect(parseQuestionCallbackData("qst:req-1:q1")).toBeNull();
    expect(parseQuestionCallbackData("qst:req-1:q1:0:extra")).toBeNull();
  });

  test("returns null for a non-integer or negative option index", () => {
    expect(parseQuestionCallbackData("qst:req-1:q1:abc")).toBeNull();
    expect(parseQuestionCallbackData("qst:req-1:q1:-1")).toBeNull();
    expect(parseQuestionCallbackData("qst:req-1:q1:1.5")).toBeNull();
  });

  test("returns null for an empty requestId or questionId", () => {
    expect(parseQuestionCallbackData("qst::q1:0")).toBeNull();
    expect(parseQuestionCallbackData("qst:req-1::0")).toBeNull();
  });
});
