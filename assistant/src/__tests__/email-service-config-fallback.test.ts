/**
 * Tests that getPrimaryInboxAddress() falls back to the workspace config's
 * email.address when the provider is unavailable (local providers removed).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the service
// ---------------------------------------------------------------------------

let mockRawConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    const keys = path.split(".");
    let current: unknown = obj;
    for (const key of keys) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  },
  saveRawConfig: () => {},
  setNestedValue: () => {},
}));

// Stub guardrails (imported by service.ts but not relevant here)
mock.module("../email/guardrails.js", () => ({
  addAddressRule: () => ({}),
  checkSendGuardrails: () => null,
  getGuardrailsStatus: () => ({}),
  incrementDailySendCount: () => 0,
  listRules: () => [],
  removeAddressRule: () => false,
  setDailySendCap: () => {},
  setOutboundPaused: () => {},
}));

// Now import the service under test
const { EmailService } = await import("../email/service.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPrimaryInboxAddress — config fallback", () => {
  afterEach(() => {
    mockRawConfig = {};
  });

  test("falls back to email.address from config (provider removed)", async () => {
    mockRawConfig = { email: { address: "configured@vellum.me" } };
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBe("configured@vellum.me");
  });

  test("returns undefined when config has no address", async () => {
    mockRawConfig = {};
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBeUndefined();
  });
});
