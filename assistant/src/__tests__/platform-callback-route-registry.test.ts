/**
 * Enforcement tests for the platform callback route registry.
 *
 * Ensures every webhook route declared in the gateway's route table has a
 * corresponding entry in WEBHOOK_CALLBACK_ROUTES so that containerized
 * deployments register all necessary callback routes on startup.
 */
import { describe, expect, test } from "bun:test";

import { WEBHOOK_CALLBACK_ROUTES } from "../inbound/platform-callback-registration.js";

// Canonical list of webhook paths from the gateway route table
// (gateway/src/index.ts). Only routes under /webhooks/ that receive inbound
// provider callbacks need platform registration.
const GATEWAY_WEBHOOK_PATHS = [
  "/webhooks/telegram",
  "/webhooks/twilio/voice",
  "/webhooks/twilio/status",
  "/webhooks/twilio/connect-action",
  "/webhooks/whatsapp",
  "/webhooks/oauth/callback",
];

describe("platform callback route registry", () => {
  test("every gateway webhook route has a corresponding WEBHOOK_CALLBACK_ROUTES entry", () => {
    /**
     * If this test fails, a new webhook route was added to the gateway
     * without a matching entry in WEBHOOK_CALLBACK_ROUTES. Add the route
     * to the registry so containerized deployments register it on startup.
     */
    const registeredPaths = WEBHOOK_CALLBACK_ROUTES.map(
      (r) => `/${r.callbackPath}`,
    );

    for (const gatewayPath of GATEWAY_WEBHOOK_PATHS) {
      expect(registeredPaths).toContain(gatewayPath);
    }
  });

  test("WEBHOOK_CALLBACK_ROUTES does not contain stale entries absent from the gateway", () => {
    /**
     * If this test fails, a route was removed from the gateway but its
     * WEBHOOK_CALLBACK_ROUTES entry was not cleaned up.
     */
    const gatewayPathSet = new Set(GATEWAY_WEBHOOK_PATHS);

    for (const route of WEBHOOK_CALLBACK_ROUTES) {
      expect(gatewayPathSet.has(`/${route.callbackPath}`)).toBe(true);
    }
  });

  test("every entry has a non-empty callbackPath and type", () => {
    for (const route of WEBHOOK_CALLBACK_ROUTES) {
      expect(route.callbackPath.length).toBeGreaterThan(0);
      expect(route.type.length).toBeGreaterThan(0);
    }
  });

  test("callbackPath values are unique", () => {
    const paths = WEBHOOK_CALLBACK_ROUTES.map((r) => r.callbackPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("type values are unique", () => {
    const types = WEBHOOK_CALLBACK_ROUTES.map((r) => r.type);
    expect(new Set(types).size).toBe(types.length);
  });
});
