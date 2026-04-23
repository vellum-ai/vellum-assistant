/**
 * Unit tests for the `host.identity.*` skill IPC routes. Mocks
 * `getAssistantName()` so we can assert both the resolved-name and
 * missing-name paths, and pins the internal assistant ID to the
 * canonical "self" constant.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock identity helper
// ---------------------------------------------------------------------------

let mockName: string | null = null;

mock.module("../../../daemon/identity-helpers.js", () => ({
  getAssistantName: () => mockName,
}));

const {
  hostIdentityGetAssistantNameRoute,
  hostIdentityGetInternalAssistantIdRoute,
  identityRoutes,
} = await import("../identity.js");

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

describe("host.identity.getInternalAssistantId IPC route", () => {
  test("method is host.identity.getInternalAssistantId", () => {
    expect(hostIdentityGetInternalAssistantIdRoute.method).toBe(
      "host.identity.getInternalAssistantId",
    );
  });

  test("returns the daemon internal assistant id constant", async () => {
    const result = await hostIdentityGetInternalAssistantIdRoute.handler();

    expect(result).toBe("self");
  });
});

describe("identityRoutes", () => {
  test("exports both identity routes", () => {
    expect(identityRoutes).toContain(hostIdentityGetAssistantNameRoute);
    expect(identityRoutes).toContain(hostIdentityGetInternalAssistantIdRoute);
  });
});
