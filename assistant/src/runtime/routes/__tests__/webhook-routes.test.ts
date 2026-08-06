/**
 * Unit tests for the webhooks_register route handler's callback-URL
 * resolution order (LUM-2863).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { InternalError, UnprocessableEntityError } from "../errors.js";

let isPlatform = false;
let config: Record<string, unknown> = {};
let platformContextEnabled = false;
let registerCallbackRouteError: Error | undefined;

const registerCallbackRouteMock = mock(
  async (callbackPath: string, _type: string, _source?: string) => {
    if (registerCallbackRouteError) {
      throw registerCallbackRouteError;
    }
    return `https://gateway.vellum.ai/assistant-123/${callbackPath}`;
  },
);

// Spread the real modules: these are broad barrels and replacing them wholesale
// breaks unrelated importers pulled in by the module under test.
const actualEnvRegistry = await import("../../../config/env-registry.js");
mock.module("../../../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsPlatform: () => isPlatform,
}));

const actualLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => config,
}));

mock.module("../../../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: registerCallbackRouteMock,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform,
    platformBaseUrl: "https://api.vellum.ai",
    assistantId: platformContextEnabled ? "assistant-123" : "",
    hasAssistantApiKey: platformContextEnabled,
    authHeader: platformContextEnabled ? "Api-Key secret" : null,
    enabled: platformContextEnabled,
  }),
}));

const { ROUTES } = await import("../webhook-routes.js");

const registerRoute = ROUTES.find(
  (r) => r.operationId === "webhooks_register",
)!;

const register = (body: Record<string, unknown>) =>
  registerRoute.handler({ body });

describe("webhooks_register callback URL resolution", () => {
  beforeEach(() => {
    isPlatform = false;
    config = {};
    platformContextEnabled = false;
    registerCallbackRouteError = undefined;
    registerCallbackRouteMock.mockClear();
  });

  test("platform pods register with the platform gateway", async () => {
    isPlatform = true;
    platformContextEnabled = true;

    expect(await register({ type: "telegram" })).toEqual({
      callbackUrl: "https://gateway.vellum.ai/assistant-123/webhooks/telegram",
      type: "telegram",
      path: "webhooks/telegram",
      mode: "platform",
    });
  });

  // The bug: a local assistant that IS connected to the platform used to fall
  // through to the self-hosted branch and 422 when it had no public ingress.
  test("platform-connected local assistant with no ingress gets the platform callback URL", async () => {
    platformContextEnabled = true;

    expect(await register({ type: "telegram" })).toEqual({
      callbackUrl: "https://gateway.vellum.ai/assistant-123/webhooks/telegram",
      type: "telegram",
      path: "webhooks/telegram",
      mode: "platform",
    });
    expect(registerCallbackRouteMock).toHaveBeenCalledWith(
      "webhooks/telegram",
      "telegram",
      undefined,
    );
  });

  test("disconnected local assistant uses the configured publicBaseUrl", async () => {
    config = { ingress: { publicBaseUrl: "https://abc.ngrok.io" } };

    expect(await register({ type: "telegram" })).toEqual({
      callbackUrl: "https://abc.ngrok.io/webhooks/telegram",
      type: "telegram",
      path: "webhooks/telegram",
      mode: "self-hosted",
    });
    expect(registerCallbackRouteMock).not.toHaveBeenCalled();
  });

  test("disconnected local assistant with no ingress is still unprocessable", async () => {
    await expect(register({ type: "telegram" })).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
  });

  // A logged-in local assistant holds platform credentials for the LLM proxy,
  // so credential presence must not override an explicitly configured tunnel.
  test("a configured publicBaseUrl wins over platform connectivity", async () => {
    platformContextEnabled = true;
    config = { ingress: { publicBaseUrl: "https://abc.ngrok.io" } };

    expect(await register({ type: "telegram" })).toMatchObject({
      callbackUrl: "https://abc.ngrok.io/webhooks/telegram",
      mode: "self-hosted",
    });
    expect(registerCallbackRouteMock).not.toHaveBeenCalled();
  });

  // The gateway publishes the Velay tunnel URL into ingress.publicBaseUrl, so
  // a tunneled platform-connected assistant already resolves to a stable
  // platform-owned URL through the ingress tier.
  test("a Velay-managed publicBaseUrl resolves through the ingress tier", async () => {
    platformContextEnabled = true;
    config = {
      ingress: {
        publicBaseUrl: "https://velay.vellum.ai/assistant-123",
        publicBaseUrlManagedBy: "velay",
      },
    };

    expect(await register({ type: "twilio_voice" })).toEqual({
      callbackUrl:
        "https://velay.vellum.ai/assistant-123/webhooks/twilio/voice",
      type: "twilio_voice",
      path: "webhooks/twilio/voice",
      mode: "self-hosted",
    });
  });

  test("explicitly disabled ingress is not routed around via the platform", async () => {
    platformContextEnabled = true;
    config = { ingress: { enabled: false } };

    await expect(register({ type: "telegram" })).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(registerCallbackRouteMock).not.toHaveBeenCalled();
  });

  test("the source identifier is forwarded to the platform registration", async () => {
    platformContextEnabled = true;

    await register({ type: "telegram", source: "@my_bot" });

    expect(registerCallbackRouteMock).toHaveBeenCalledWith(
      "webhooks/telegram",
      "telegram",
      "@my_bot",
    );
  });

  test("a failed platform registration surfaces as a 500", async () => {
    platformContextEnabled = true;
    registerCallbackRouteError = new Error(
      "Platform callback route registration failed (HTTP 502)",
    );

    await expect(register({ type: "telegram" })).rejects.toBeInstanceOf(
      InternalError,
    );
  });

  test("a missing platform registration context surfaces as a 422", async () => {
    platformContextEnabled = true;
    registerCallbackRouteError = new Error(
      "Platform callbacks not available — missing platform registration context",
    );

    await expect(register({ type: "telegram" })).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
  });

  test("a path override replaces the derived webhook path", async () => {
    platformContextEnabled = true;

    expect(
      await register({ type: "custom", path: "webhooks/my-provider" }),
    ).toMatchObject({ path: "webhooks/my-provider" });
  });
});
