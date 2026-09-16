import { describe, expect, test } from "bun:test";

import { parseCallbackData } from "../runtime/routes/channel-route-shared.js";

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
    expect(result!.source).toBe("button");
  });

  // A retired action id is not an approval. Mapping one onto `approve_once`
  // would let a future scoped action id degrade silently to one-shot.
  test.each([
    "apr:req-123:approve_10m",
    "apr:req-123:approve_conversation",
    "apr:req-123:approve_always",
  ])('returns null for the retired action id in "%s"', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });

  test("every channel's button press attributes as the button modality", () => {
    for (const channel of ["slack", "telegram", "whatsapp", "discord"]) {
      const result = parseCallbackData("apr:req-789:approve_once", channel);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("approve_once");
      expect(result!.requestId).toBe("req-789");
      expect(result!.source).toBe("button");
    }
  });

  test("an in-app surface press attributes as vellum_surface", () => {
    const result = parseCallbackData("apr:req-789:approve_once", "vellum");
    expect(result!.source).toBe("vellum_surface");
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
