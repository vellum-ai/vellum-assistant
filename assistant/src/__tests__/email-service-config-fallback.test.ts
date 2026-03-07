/**
 * Tests that getPrimaryInboxAddress() falls back to the workspace config's
 * email.address when the provider can't list inboxes.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the service
// ---------------------------------------------------------------------------

let mockProviderThrows = false;
let mockProviderInboxes: { address: string }[] = [];

mock.module("../email/providers/index.js", () => ({
  createProvider: async () => ({
    name: "mock",
    health: async () => {
      if (mockProviderThrows) throw new Error("provider unavailable");
      return { inboxes: mockProviderInboxes, domains: [] };
    },
  }),
  getActiveProviderName: () => "mock",
}));

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
mock.module("../cli/email-guardrails.js", () => ({
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
    mockProviderThrows = false;
    mockProviderInboxes = [];
    mockRawConfig = {};
  });

  test("returns provider inbox address when available", async () => {
    mockProviderInboxes = [{ address: "inbox@provider.example" }];
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBe("inbox@provider.example");
  });

  test("falls back to email.address from config when provider returns no inboxes", async () => {
    mockProviderInboxes = [];
    mockRawConfig = { email: { address: "configured@example.com" } };
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBe("configured@example.com");
  });

  test("falls back to email.address from config when provider throws", async () => {
    mockProviderThrows = true;
    mockRawConfig = { email: { address: "fallback@example.com" } };
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBe("fallback@example.com");
  });

  test("returns undefined when neither provider nor config has an address", async () => {
    mockProviderThrows = true;
    mockRawConfig = {};
    const svc = new EmailService();

    const addr = await svc.getPrimaryInboxAddress();
    expect(addr).toBeUndefined();
  });
});
