import { describe, expect, test } from "bun:test";

import { ROUTES } from "../platform-routes.js";

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

describe("platform routes", () => {
  test("platform status is readable by gateway-proxied browser callers", () => {
    const route = findRoute("platform_status");

    expect(route.policy?.requiredScopes).toEqual(["settings.read"]);
    expect(route.policy?.allowedPrincipalTypes).toContain("actor");
    expect(route.policy?.allowedPrincipalTypes).toContain("svc_gateway");
    expect(route.policy?.allowedPrincipalTypes).toContain("local");
  });

  test("platform credential mutations remain local-only", () => {
    for (const operationId of ["platform_connect", "platform_disconnect"]) {
      const route = findRoute(operationId);
      expect(route.policy?.allowedPrincipalTypes).toEqual(["local"]);
    }
  });
});
