/**
 * Shareable app pages are served outside the /v1/ namespace, at
 * `GET /pages/:appId`, but they are an ordinary entry in the shared ROUTES
 * array and carry an ordinary policy (`settings.read`, actor principals).
 *
 * These tests pin that the bare path dispatches through the router, so the
 * declared policy is enforced there: a single-route grant handed to a
 * third-party binary is refused, and a normal client still gets its page.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const APP_ID = "app-under-test";
const appDir = mkdtempSync(join(tmpdir(), "vellum-pages-"));
mkdirSync(join(appDir, "dist"), { recursive: true });
writeFileSync(
  join(appDir, "dist", "index.html"),
  '<!DOCTYPE html><html><body><script src="./main.js"></script></body></html>',
);

const appStore = await import("../../apps/app-store.js");
// Captured before the mock replaces the namespace's own binding, which would
// otherwise make the fall-through below call itself.
const resolveRealAppSource = appStore.resolveAppSource;
mock.module("../../apps/app-store.js", () => ({
  ...appStore,
  // Only the app under test is stubbed onto a temp dir; every other id falls
  // through to the real resolver, so what the router hands it is exercised.
  resolveAppSource: (id: string) =>
    id === APP_ID
      ? {
          id: APP_ID,
          name: "Test App",
          dirName: APP_ID,
          sourceDir: appDir,
          origin: { kind: "workspace" },
        }
      : resolveRealAppSource(id),
}));

const { setDbReady } = await import("../../daemon/daemon-readiness.js");
const { CURRENT_POLICY_EPOCH } = await import("../auth/policy.js");
const { mintToken } = await import("../auth/token-service.js");
const { RuntimeHttpServer } = await import("../http-server.js");

/** A desktop/web client token: `actor_client_v1` carries settings.read. */
const ACTOR_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:test-principal",
  scope_profile: "actor_client_v1",
  policy_epoch: CURRENT_POLICY_EPOCH,
  ttlSeconds: 3600,
});

/** The grant `assistant oauth proxy-url` hands to a third-party binary. */
const PROXY_GRANT_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "local:self:oauth-proxy.stripe_link",
  scope_profile: "oauth_proxy_v1",
  policy_epoch: CURRENT_POLICY_EPOCH,
  ttlSeconds: 3600,
});

describe("GET /pages/:appId enforces its route policy", () => {
  let server: InstanceType<typeof RuntimeHttpServer>;
  let port = 0;

  beforeAll(async () => {
    setDbReady(true);
    server = new RuntimeHttpServer({ port: await getFreePort() });
    await server.start();
    port = server.actualPort;
  });

  afterAll(async () => {
    await server?.stop();
  });

  function fetchPage(token: string, appId = APP_ID): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/pages/${appId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  test("serves the page to a client holding settings.read", async () => {
    const response = await fetchPage(ACTOR_JWT);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    // Relative asset paths are rewritten onto the HTTP dist route.
    expect(await response.text()).toContain(
      `src="/v1/apps/${APP_ID}/dist/main.js"`,
    );
  });

  test("refuses an oauth_proxy_v1 grant", async () => {
    const response = await fetchPage(PROXY_GRANT_JWT);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("refuses a request with no token at all", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/pages/${APP_ID}`);

    expect(response.status).toBe(401);
  });

  test("an unknown app is a 404, not a 500", async () => {
    const response = await fetchPage(ACTOR_JWT, "no-such-app");

    expect(response.status).toBe(404);
  });

  test("an id that decodes to a traversal is a 404, not a 500", async () => {
    // The router percent-decodes its path params, so the handler is asked to
    // resolve "../foo". Traversal is refused either way; the caller reads it
    // as an app that does not exist rather than a fault in the daemon.
    const response = await fetchPage(ACTOR_JWT, "%2E%2E%2Ffoo");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("..");
  });
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate free port"));
        }
      });
    });
  });
}
