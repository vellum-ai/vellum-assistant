import { describe, expect, test } from "bun:test";

import { parseApprovalDecision } from "../runtime/channel-approval-parser.js";
import { parseCallbackData } from "../runtime/routes/channel-route-shared.js";

// ═══════════════════════════════════════════════════════════════════════════
// Plain-text approval decision parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseApprovalDecision", () => {
  // ── Approve once ──────────────────────────────────────────────────

  test.each([
    "yes",
    "Yes",
    "YES",
    "approve",
    "Approve",
    "APPROVE",
    "allow",
    "Allow",
    "go ahead",
    "Go Ahead",
    "GO AHEAD",
    "approve once",
    "Approve once",
    "Approve Once",
    "APPROVE ONCE",
  ])('recognises "%s" as approve_once', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
    expect(result!.source).toBe("plain_text");
  });

  // ── Approve for 10 minutes ────────────────────────────────────────

  test.each([
    "approve for 10 minutes",
    "Approve for 10 minutes",
    "APPROVE FOR 10 MINUTES",
    "allow for 10 minutes",
    "Allow for 10 minutes",
    "ALLOW FOR 10 MINUTES",
    "approve 10m",
    "Approve 10m",
    "APPROVE 10M",
    "allow 10m",
    "approve 10 min",
    "allow 10 min",
  ])('recognises "%s" as approve_10m', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_10m");
    expect(result!.source).toBe("plain_text");
  });

  // ── Approve for thread ────────────────────────────────────────────

  test.each([
    "approve for thread",
    "Approve for thread",
    "APPROVE FOR THREAD",
    "allow for thread",
    "Allow for thread",
    "ALLOW FOR THREAD",
    "approve thread",
    "Approve thread",
    "APPROVE THREAD",
    "allow thread",
  ])('recognises "%s" as approve_thread', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_thread");
    expect(result!.source).toBe("plain_text");
  });

  // ── Approve always ────────────────────────────────────────────────

  test.each([
    "always",
    "Always",
    "ALWAYS",
    "approve always",
    "Approve Always",
    "APPROVE ALWAYS",
    "allow always",
    "Allow Always",
    "ALLOW ALWAYS",
  ])('recognises "%s" as approve_always', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_always");
    expect(result!.source).toBe("plain_text");
  });

  // ── Reject ────────────────────────────────────────────────────────

  test.each([
    "no",
    "No",
    "NO",
    "reject",
    "Reject",
    "REJECT",
    "deny",
    "Deny",
    "DENY",
    "cancel",
    "Cancel",
    "CANCEL",
  ])('recognises "%s" as reject', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("reject");
    expect(result!.source).toBe("plain_text");
  });

  // ── Whitespace handling ───────────────────────────────────────────

  test("trims leading and trailing whitespace", () => {
    const result = parseApprovalDecision("  approve  ");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
  });

  test("trims tabs and newlines", () => {
    const result = parseApprovalDecision("\t\nreject\n\t");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("reject");
  });

  // ── Non-matching text ─────────────────────────────────────────────

  test.each([
    "",
    "   ",
    "hello",
    "please approve this",
    "I approve",
    "yes please",
    "nope",
    "approved",
    "allow me",
    "go",
    "ahead",
    "maybe",
  ])('returns null for non-matching text: "%s"', (input) => {
    expect(parseApprovalDecision(input)).toBeNull();
  });

  // ── Request-reference tag extraction ────────────────────────────────

  test("extracts requestId from [ref:...] tag with approve decision", () => {
    const result = parseApprovalDecision("yes [ref:req-abc-123]");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
    expect(result!.source).toBe("plain_text");
    expect(result!.requestId).toBe("req-abc-123");
  });

  test("extracts requestId from [ref:...] tag with reject decision", () => {
    const result = parseApprovalDecision("no [ref:req-xyz-456]");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("reject");
    expect(result!.requestId).toBe("req-xyz-456");
  });

  test("extracts requestId from [ref:...] tag with always decision", () => {
    const result = parseApprovalDecision("always [ref:req-789]");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_always");
    expect(result!.requestId).toBe("req-789");
  });

  test("extracts requestId from [ref:...] tag with approve_10m decision", () => {
    const result = parseApprovalDecision(
      "approve for 10 minutes [ref:req-timer]",
    );
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_10m");
    expect(result!.requestId).toBe("req-timer");
  });

  test("extracts requestId from [ref:...] tag with approve_thread decision", () => {
    const result = parseApprovalDecision("approve for thread [ref:req-thread]");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_thread");
    expect(result!.requestId).toBe("req-thread");
  });

  test("handles ref tag on separate line", () => {
    const result = parseApprovalDecision("yes\n[ref:req-abc-123]");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_once");
    expect(result!.requestId).toBe("req-abc-123");
  });

  test("decision without ref tag has no requestId", () => {
    const result = parseApprovalDecision("yes");
    expect(result).not.toBeNull();
    expect(result!.requestId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Callback data parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCallbackData", () => {
  test.each([
    ["apr:req-123:approve_once", "approve_once"],
    ["apr:req-123:approve_10m", "approve_10m"],
    ["apr:req-123:approve_thread", "approve_thread"],
    ["apr:req-123:approve_always", "approve_always"],
    ["apr:req-123:reject", "reject"],
  ] as const)('parses "%s" as action "%s"', (data, expectedAction) => {
    const result = parseCallbackData(data);
    expect(result).not.toBeNull();
    expect(result!.action).toBe(expectedAction);
    expect(result!.requestId).toBe("req-123");
    expect(result!.source).toBe("telegram_button");
  });

  test("parses whatsapp source channel", () => {
    const result = parseCallbackData("apr:req-456:approve_10m", "whatsapp");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approve_10m");
    expect(result!.source).toBe("whatsapp_button");
  });

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
