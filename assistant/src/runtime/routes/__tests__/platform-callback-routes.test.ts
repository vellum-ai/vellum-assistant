import { expect, mock, test } from "bun:test";

import {
  PublicIngressDisabledError,
  PublicIngressNotConfiguredError,
} from "../../../inbound/public-ingress-urls.js";

let failure: Error;
const actual =
  await import("../../../inbound/platform-callback-registration.js");
mock.module("../../../inbound/platform-callback-registration.js", () => ({
  ...actual,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl: "https://platform.example.com",
    assistantId: "assistant-123",
    hasAssistantApiKey: true,
    authHeader: "Api-Key example-key",
    enabled: true,
  }),
  registerCallbackRoute: async () => {
    throw failure;
  },
}));
const { ROUTES } = await import("../platform-routes.js");
const handler = ROUTES.find(
  (route) => route.operationId === "platform_callback_routes_register",
)!.handler;

test.each([
  new PublicIngressNotConfiguredError(),
  new PublicIngressDisabledError(),
])(
  "the CLI registration route preserves the callback prerequisite: %s",
  async (error) => {
    failure = error;
    await expect(
      handler({ body: { path: "webhooks/oauth/callback", type: "oauth" } }),
    ).rejects.toBe(error);
  },
);

test("unexpected registration failures remain server errors", async () => {
  failure = new Error("Platform unavailable");
  await expect(
    handler({ body: { path: "webhooks/oauth/callback", type: "oauth" } }),
  ).rejects.toMatchObject({ statusCode: 500, code: "INTERNAL_ERROR" });
});
