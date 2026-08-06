import { beforeEach, describe, expect, test } from "bun:test";

import { runPlatform, setupPlatformIpcMock } from "./helpers.js";

const ipc = setupPlatformIpcMock();

describe("assistant platform plans", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: true,
      result: {
        plans: [
          {
            id: "base",
            name: "Base",
            price_cents: 0,
            billing_interval: "month",
            included_features: ["Pay-as-you-go credits"],
          },
          {
            id: "pro",
            name: "Pro",
            base_price_cents: 2000,
            billing_interval: "month",
            included_features: ["Configurable machine size"],
          },
        ],
      },
    };
  });

  test("calls platform_plans and emits catalog JSON with --json", async () => {
    const out = await runPlatform(["plans", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_plans");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.plans[0].id).toBe("base");
    expect(parsed.plans[1].base_price_cents).toBe(2000);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await runPlatform(["plans"]);

    // Plain-text mode logs via log.info; verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
