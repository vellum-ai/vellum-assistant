import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: override VELLUM_WORKSPACE_DIR so guardrails state uses a temp dir
// ---------------------------------------------------------------------------
const testDir = join(tmpdir(), `email-cli-test-${Date.now()}`);
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.VELLUM_WORKSPACE_DIR = testDir;
});

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Provider factory tests
// ---------------------------------------------------------------------------
describe("email provider factory", () => {
  test("getActiveProviderName returns platform", async () => {
    const { getActiveProviderName } =
      await import("../email/providers/index.js");
    expect(getActiveProviderName()).toBe("platform");
  });

  test("SUPPORTED_PROVIDERS is empty (local providers removed)", async () => {
    const { SUPPORTED_PROVIDERS } = await import("../email/providers/index.js");
    expect(SUPPORTED_PROVIDERS).toHaveLength(0);
  });

  test("createProvider throws (local providers removed)", async () => {
    const { createProvider } = await import("../email/providers/index.js");
    try {
      await createProvider();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("removed");
    }
  });
});

// ---------------------------------------------------------------------------
// Service guardrail tests (via guardrails module directly)
// ---------------------------------------------------------------------------
describe("email guardrails", () => {
  test("pause blocks sends (returns outbound_paused)", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.setOutboundPaused(true);
    expect(guardrails.isOutboundPaused()).toBe(true);

    const result = guardrails.checkSendGuardrails(["user@example.com"]);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("outbound_paused");
  });

  test("resume allows sends", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.setOutboundPaused(true);
    guardrails.setOutboundPaused(false);

    const result = guardrails.checkSendGuardrails(["user@example.com"]);
    expect(result).toBeNull();
  });

  test("daily cap enforced", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.setDailySendCap(2);
    guardrails.incrementDailySendCount();
    guardrails.incrementDailySendCount();

    const result = guardrails.checkSendGuardrails(["user@example.com"]);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("daily_cap_reached");
    expect(result!.count).toBe(2);
    expect(result!.cap).toBe(2);
  });

  test("blocklist checked", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.addAddressRule("block", "*@spam.com");

    const result = guardrails.checkSendGuardrails(["user@spam.com"]);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("address_blocked");
    expect(result!.address).toBe("user@spam.com");
  });

  test("allowlist enforcement", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.addAddressRule("allow", "*@trusted.com");

    expect(guardrails.checkSendGuardrails(["bob@trusted.com"])).toBeNull();

    const result = guardrails.checkSendGuardrails(["bob@untrusted.com"]);
    expect(result).not.toBeNull();
    expect(result!.error).toBe("address_blocked");
    expect(result!.reason).toBe("not in allowlist");
  });

  test("rule lifecycle: add, list, remove", async () => {
    const guardrails = await import("../email/guardrails.js");

    const rule = guardrails.addAddressRule("block", "*@evil.com");
    expect(rule.id).toBeTruthy();
    expect(rule.type).toBe("block");

    const rules = guardrails.listRules();
    expect(rules.length).toBe(1);
    expect(rules[0].pattern).toBe("*@evil.com");

    expect(guardrails.removeAddressRule(rule.id)).toBe(true);
    expect(guardrails.listRules().length).toBe(0);
  });

  test("remove non-existent rule returns false", async () => {
    const guardrails = await import("../email/guardrails.js");
    expect(guardrails.removeAddressRule("non-existent")).toBe(false);
  });

  test("default cap is 25", async () => {
    const guardrails = await import("../email/guardrails.js");
    expect(guardrails.getDailySendCap()).toBe(25);
  });

  test("incrementDailySendCount returns new count", async () => {
    const guardrails = await import("../email/guardrails.js");

    expect(guardrails.incrementDailySendCount()).toBe(1);
    expect(guardrails.incrementDailySendCount()).toBe(2);
    expect(guardrails.getDailySendCount()).toBe(2);
  });

  test("guardrails check priority: pause > cap > blocklist", async () => {
    const guardrails = await import("../email/guardrails.js");

    guardrails.setOutboundPaused(true);
    guardrails.setDailySendCap(0);
    guardrails.addAddressRule("block", "*@blocked.com");

    const result = guardrails.checkSendGuardrails(["user@blocked.com"]);
    expect(result!.error).toBe("outbound_paused");
  });
});

// ---------------------------------------------------------------------------
// Service layer tests (with mocked provider)
// ---------------------------------------------------------------------------
describe("email service guardrails integration", () => {
  test("GuardrailError has correct structure", async () => {
    const { GuardrailError } = await import("../email/service.js");

    const err = new GuardrailError("outbound_paused", "Send blocked", {
      extra: true,
    });
    expect(err.code).toBe("outbound_paused");
    expect(err.message).toBe("Send blocked");
    expect(err.details).toEqual({ extra: true });
    expect(err.name).toBe("GuardrailError");
    expect(err instanceof Error).toBe(true);
  });

  test("getEmailService returns singleton", async () => {
    const { getEmailService } = await import("../email/service.js");
    const a = getEmailService();
    const b = getEmailService();
    expect(a).toBe(b);
  });

  test("service getProviderName returns platform", async () => {
    const { getEmailService } = await import("../email/service.js");
    const svc = getEmailService();
    expect(svc.getProviderName()).toBe("platform");
  });

  test("service guardrails methods work", async () => {
    const { getEmailService } = await import("../email/service.js");
    const svc = getEmailService();

    const initial = svc.getGuardrails();
    expect(initial.paused).toBe(false);
    expect(initial.dailyCap).toBe(25);

    svc.setGuardrails({ paused: true, dailyCap: 10 });
    const updated = svc.getGuardrails();
    expect(updated.paused).toBe(true);
    expect(updated.dailyCap).toBe(10);
  });

  test("service address rule methods work", async () => {
    const { getEmailService } = await import("../email/service.js");
    const svc = getEmailService();

    const rule = svc.addRule("block", "*@test.com");
    expect(rule.type).toBe("block");

    const rules = svc.listAddressRules();
    expect(rules.length).toBe(1);

    expect(svc.removeRule(rule.id)).toBe(true);
    expect(svc.listAddressRules().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JSON output format / contract tests
// ---------------------------------------------------------------------------
describe("email JSON contract", () => {
  test("guardrails status has expected shape", async () => {
    const guardrails = await import("../email/guardrails.js");
    const status = guardrails.getGuardrailsStatus();
    const json = JSON.stringify(status);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("paused");
    expect(parsed).toHaveProperty("dailyCap");
    expect(parsed).toHaveProperty("dailyCount");
    expect(parsed).toHaveProperty("rules");
    expect(typeof parsed.paused).toBe("boolean");
    expect(typeof parsed.dailyCap).toBe("number");
    expect(typeof parsed.dailyCount).toBe("number");
    expect(Array.isArray(parsed.rules)).toBe(true);
  });

  test("address rule has expected JSON fields", async () => {
    const guardrails = await import("../email/guardrails.js");
    const rule = guardrails.addAddressRule("block", "*@test.com");
    const parsed = JSON.parse(JSON.stringify(rule));

    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("type");
    expect(parsed).toHaveProperty("pattern");
    expect(parsed).toHaveProperty("createdAt");
    expect(parsed.type).toBe("block");
    expect(parsed.pattern).toBe("*@test.com");
  });
});

// ---------------------------------------------------------------------------
// AgentMailProvider removed — local providers replaced by platform email
// ---------------------------------------------------------------------------
