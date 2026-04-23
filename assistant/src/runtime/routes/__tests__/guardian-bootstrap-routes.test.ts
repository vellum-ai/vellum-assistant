/**
 * Tests for the guardian bootstrap access gate.
 *
 * Exercises the peer-IP and bootstrap-secret checks that run before
 * token minting. Downstream dependencies (contact store, credential
 * service) are mocked so the tests focus on the gate logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => null,
}));

mock.module("../../../contacts/contacts-write.js", () => ({
  createGuardianBinding: () => {},
}));

mock.module("../../auth/credential-service.js", () => ({
  mintCredentialPair: () => ({
    accessToken: "access-token",
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: Date.now() + 60_000,
    refreshAfter: Date.now() + 30_000,
    guardianPrincipalId: "principal-test",
  }),
}));

import { handleGuardianBootstrap } from "../guardian-bootstrap-routes.js";

// Fake Bun server that returns a fixed peer IP for requestIP().
function makeServer(peerIp: string) {
  return {
    requestIP: () => ({ address: peerIp, family: "IPv4", port: 12345 }),
  };
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:7821/v1/guardian/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ platform: "cli", deviceId: "device-test" }),
  });
}

const ENV_KEYS = [
  "IS_CONTAINERIZED",
  "VELLUM_CLOUD",
  "GUARDIAN_BOOTSTRAP_SECRET",
  "DISABLE_HTTP_AUTH",
  "VELLUM_UNSAFE_AUTH_BYPASS",
];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("handleGuardianBootstrap — Docker mode secret enforcement", () => {
  beforeEach(() => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.VELLUM_CLOUD = "docker";
  });

  test("rejects with 403 when GUARDIAN_BOOTSTRAP_SECRET env is unset (fail-closed)", async () => {
    // No GUARDIAN_BOOTSTRAP_SECRET in env — even a loopback peer must be
    // rejected so misconfigured Docker deployments don't silently expose
    // the token-minting endpoint.
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-bootstrap-secret": "anything" }),
      makeServer("127.0.0.1"),
    );
    expect(res.status).toBe(403);
  });

  test("rejects with 403 when x-bootstrap-secret header is missing", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "expected-secret";
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("172.17.0.1"),
    );
    expect(res.status).toBe(403);
  });

  test("rejects with 403 when x-bootstrap-secret header does not match", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "expected-secret";
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-bootstrap-secret": "wrong-secret" }),
      makeServer("172.17.0.1"),
    );
    expect(res.status).toBe(403);
  });

  test("accepts a correct x-bootstrap-secret from a private-network peer", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "expected-secret";
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-bootstrap-secret": "expected-secret" }),
      makeServer("172.17.0.1"),
    );
    expect(res.status).toBe(200);
  });

  test("accepts any secret in a comma-separated GUARDIAN_BOOTSTRAP_SECRET list", async () => {
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "secret-a, secret-b ,secret-c";
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-bootstrap-secret": "secret-b" }),
      makeServer("10.0.0.5"),
    );
    expect(res.status).toBe(200);
  });

  test("rejects a non-private peer even with a valid secret", async () => {
    // The peer-IP gate still fires first, preventing LAN-scan exploits
    // from requests that don't route through the Docker bridge.
    process.env.GUARDIAN_BOOTSTRAP_SECRET = "expected-secret";
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-bootstrap-secret": "expected-secret" }),
      makeServer("8.8.8.8"),
    );
    expect(res.status).toBe(403);
  });

  test("bypasses the secret check when HTTP auth is disabled (dev-only escape)", async () => {
    process.env.DISABLE_HTTP_AUTH = "true";
    process.env.VELLUM_UNSAFE_AUTH_BYPASS = "1";
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("192.168.1.10"),
    );
    expect(res.status).toBe(200);
  });
});

describe("handleGuardianBootstrap — non-Docker containerized modes", () => {
  // Apple-container pods and managed platform pods set IS_CONTAINERIZED=true
  // but keep the runtime port inside the pod network. They do not need (or
  // set) GUARDIAN_BOOTSTRAP_SECRET, so the gate must not fire for them.

  test("Apple-container pod accepts loopback peer without a bootstrap secret", async () => {
    process.env.IS_CONTAINERIZED = "true";
    process.env.VELLUM_CLOUD = "apple-container";
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("127.0.0.1"),
    );
    expect(res.status).toBe(200);
  });

  test("containerized without VELLUM_CLOUD accepts a private-network peer without a secret", async () => {
    process.env.IS_CONTAINERIZED = "true";
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("172.17.0.1"),
    );
    expect(res.status).toBe(200);
  });
});

describe("handleGuardianBootstrap — bare-metal mode (unchanged)", () => {
  // IS_CONTAINERIZED intentionally not set.

  test("accepts a loopback peer without a bootstrap secret", async () => {
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("127.0.0.1"),
    );
    expect(res.status).toBe(200);
  });

  test("rejects a non-loopback peer even on the private network", async () => {
    const res = await handleGuardianBootstrap(
      makeRequest(),
      makeServer("192.168.1.50"),
    );
    expect(res.status).toBe(403);
  });

  test("rejects when x-forwarded-for is present (gateway-proxied from non-loopback client)", async () => {
    const res = await handleGuardianBootstrap(
      makeRequest({ "x-forwarded-for": "203.0.113.5" }),
      makeServer("127.0.0.1"),
    );
    expect(res.status).toBe(403);
  });
});
