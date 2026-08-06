import { beforeEach, describe, expect, test } from "bun:test";

import { runPlatform, setupPlatformIpcMock } from "./helpers.js";

const ipc = setupPlatformIpcMock();

describe("assistant platform subscription", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: true,
      result: {
        planId: "pro",
        status: "active",
        renewalDate: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        selectedCreditTier: "credits_50",
        package: { key: "super", name: "Super", version: 2, customized: false },
        entitlements: { managedEmail: true, phoneNumber: false },
      },
    };
  });

  test("calls platform_subscription and emits plan JSON with --json", async () => {
    const out = await runPlatform(["subscription", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_subscription");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.planId).toBe("pro");
    expect(parsed.status).toBe("active");
    expect(parsed.package.name).toBe("Super");
    expect(parsed.entitlements.managedEmail).toBe(true);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await runPlatform(["subscription"]);

    // Plain-text mode logs via log.info; verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
