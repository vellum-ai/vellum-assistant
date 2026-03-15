import { describe, expect, test } from "bun:test";

import { parseCallbackData } from "../runtime/routes/channel-route-shared.js";

// ═══════════════════════════════════════════════════════════════════════════
// Callback data parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCallbackData", () => {
  test.each([
    ["apr:req-123:approve_once", "approve_once"],
    ["apr:req-123:approve_10m", "approve_10m"],
    ["apr:req-123:approve_conversation", "approve_conversation"],
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
