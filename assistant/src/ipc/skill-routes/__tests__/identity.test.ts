/**
 * Unit tests for the `host.identity.*` skill IPC routes. Mocks
 * `getAssistantName()` so we can assert both the resolved-name and
 * missing-name paths.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock identity helper
// ---------------------------------------------------------------------------

let mockName: string | null = null;

mock.module("../../../daemon/identity-helpers.js", () => ({
  getAssistantName: () => mockName,
}));

const { hostIdentityGetAssistantNameRoute, identityRoutes } =
  await import("../identity.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockName = null;
});

afterEach(() => {
  mockName = null;
});

describe("host.identity.getAssistantName IPC route", () => {
  test("method is host.identity.getAssistantName", () => {
    expect(hostIdentityGetAssistantNameRoute.method).toBe(
      "host.identity.getAssistantName",
    );
  });

  test("returns the name resolved by the daemon identity helper", async () => {
    mockName = "Example Assistant";

    const result = await hostIdentityGetAssistantNameRoute.handler();

    expect(result).toBe("Example Assistant");
  });

  test("returns null when the daemon helper returns null", async () => {
    mockName = null;

    const result = await hostIdentityGetAssistantNameRoute.handler();

    expect(result).toBeNull();
  });
});

describe("identityRoutes", () => {
  test("exports the identity route", () => {
    expect(identityRoutes).toContain(hostIdentityGetAssistantNameRoute);
  });
});
