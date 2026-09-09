import { describe, expect, test } from "bun:test";

import { IpcConnectError } from "@vellumai/gateway-client/ipc-client";

import { withErrorHandling } from "../runtime/middleware/error-handler.js";
import { ConfigError, ProviderNotConfiguredError } from "../util/errors.js";

describe("withErrorHandling – friendly error messages", () => {
  test("ProviderNotConfiguredError returns actionable message for anthropic", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("anthropic", []);
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.error.message).toContain("No API key configured");
    expect(body.error.message).toContain("keys set anthropic");
  });

  test("ProviderNotConfiguredError tailors keys set command to requested provider", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new ProviderNotConfiguredError("openai", []);
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain("keys set openai");
    expect(body.error.message).not.toContain("keys set anthropic");
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

  test("IpcConnectError surfaces as 503 SERVICE_UNAVAILABLE", async () => {
    const response = await withErrorHandling("test", async () => {
      throw new IpcConnectError("connect ENOENT", "ENOENT");
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("Gateway is not reachable over IPC");
  });
});
