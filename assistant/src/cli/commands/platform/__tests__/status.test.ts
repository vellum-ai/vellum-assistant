import { beforeEach, describe, expect, test } from "bun:test";

import { runPlatform, setupPlatformIpcMock } from "./helpers.js";

const ipc = setupPlatformIpcMock();

describe("assistant platform status", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: true,
      result: {
        isPlatform: false,
        baseUrl: "",
        assistantId: "",
        hasAssistantApiKey: false,
        hasWebhookSecret: false,
        available: false,
        organizationId: null,
        userId: null,
      },
    };
  });

  test("platform pod returns full status from context", async () => {
    ipc.response = {
      ok: true,
      result: {
        isPlatform: true,
        baseUrl: "https://platform.vellum.ai",
        assistantId: "asst-abc-123",
        hasAssistantApiKey: true,
        hasWebhookSecret: true,
        available: true,
        organizationId: "org-456",
        userId: "user-789",
      },
    };

    const out = await runPlatform(["status", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_status");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.isPlatform).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
    expect(parsed.assistantId).toBe("asst-abc-123");
    expect(parsed.hasAssistantApiKey).toBe(true);
    expect(parsed.hasWebhookSecret).toBe(true);
    expect(parsed.available).toBe(true);
    expect(parsed.organizationId).toBe("org-456");
    expect(parsed.userId).toBe("user-789");
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await runPlatform(["status"]);

    // Plain-text mode logs via log.info; verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
