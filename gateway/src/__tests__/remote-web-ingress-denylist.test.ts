import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const gatewayIndexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

const nginxIngressSource = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "cli",
    "src",
    "lib",
    "nginx-ingress.ts",
  ),
  "utf8",
);

function extractGatewayRouteObjects(): string[] {
  const routesStart = gatewayIndexSource.indexOf(
    "const routes: RouteDefinition[] = [",
  );
  const routesEnd = gatewayIndexSource.indexOf(
    "// Runtime proxy catch-all",
    routesStart,
  );
  expect(routesStart).toBeGreaterThanOrEqual(0);
  expect(routesEnd).toBeGreaterThan(routesStart);

  const routesSource = gatewayIndexSource.slice(routesStart, routesEnd);
  return routesSource.split(/\n    \},\n/);
}

function extractUnprotectedStaticV1Routes(): string[] {
  return extractGatewayRouteObjects()
    .flatMap((routeObject) => {
      const path = routeObject.match(/path:\s*"([^"]+)"/)?.[1];
      if (!path?.startsWith("/v1/")) return [];

      const auth = routeObject.match(/auth:\s*"([^"]+)"/)?.[1];
      return auth === undefined || auth === "none" ? [path] : [];
    })
    .sort();
}

function assertDeniedBeforeV1Proxy(path: string): void {
  const proxyIndex = nginxIngressSource.indexOf("location ^~ /v1/ {");
  expect(proxyIndex).toBeGreaterThanOrEqual(0);

  for (const deniedPath of [path, `${path}/`]) {
    const location = `location = ${deniedPath} { return 404; }`;
    const locationIndex = nginxIngressSource.indexOf(location);
    expect(locationIndex).toBeGreaterThanOrEqual(0);
    expect(locationIndex).toBeLessThan(proxyIndex);
  }
}

describe("remote web ingress denylist", () => {
  test("blocks every unprotected static gateway /v1 route before proxying /v1", () => {
    const unprotectedV1Routes = extractUnprotectedStaticV1Routes();
    expect(unprotectedV1Routes).toEqual([
      "/v1/devices",
      "/v1/devices/revoke",
      "/v1/guardian/init",
      "/v1/guardian/reset-bootstrap",
      "/v1/pair",
    ]);

    for (const path of unprotectedV1Routes) {
      assertDeniedBeforeV1Proxy(path);
    }
  });

  test("blocks local web token minting before proxying remote requests", () => {
    const tokenRoute = gatewayIndexSource.slice(
      gatewayIndexSource.indexOf("// ── Web token auth ──"),
      gatewayIndexSource.indexOf("// Runtime proxy catch-all"),
    );

    expect(tokenRoute).toContain('path: "/auth/token"');
    expect(tokenRoute).toContain('auth: "custom"');
    assertDeniedBeforeV1Proxy("/auth/token");
  });
});
