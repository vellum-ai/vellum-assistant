import { describe, expect, test } from "bun:test";

import { withErrorHandling } from "../runtime/middleware/error-handler.js";
import { ConfigError, ProviderNotConfiguredError } from "../util/errors.js";

describe("withErrorHandling – friendly error messages", () => {
  test("ProviderNotConfiguredError returns actionable message", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("anthropic", []);
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.error.message).toContain("No API key configured");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
    expect(body.error.message).toContain("vellum hatch");
  });

  test("generic ConfigError still returns its own message", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ConfigError("Twilio phone number not configured.");
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toBe("Twilio phone number not configured.");
  });
});
