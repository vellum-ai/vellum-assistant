import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for the feature-flags auth split:
 *
 * - PATCH /v1/feature-flags/:key requires the dedicated feature-flag token
 * - PATCH /v1/feature-flags/:key rejects the runtime bearer token with 403
 * - PATCH /v1/feature-flags/:key with no token returns 401
 * - GET /v1/feature-flags accepts the runtime bearer token
 * - GET /v1/feature-flags accepts the feature-flag token
 */

const RUNTIME_TOKEN = "test-runtime-bearer-token";
const FEATURE_FLAG_TOKEN = "test-feature-flag-client-token";
const FLAG_KEY = "feature_flags.hatch-new-assistant.enabled";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;
const savedFeatureFlagDefaultsPath = process.env.FEATURE_FLAG_DEFAULTS_PATH;

beforeAll(async () => {
  // Create isolated temp directory for config and token files
  tmpDir = mkdtempSync(join(tmpdir(), "gw-ff-auth-test-"));
  const vellumDir = join(tmpDir, ".vellum");
  mkdirSync(join(vellumDir, "workspace"), { recursive: true });

  // Write http-token file
  writeFileSync(join(vellumDir, "http-token"), RUNTIME_TOKEN);

  // Write feature-flag-token file
  writeFileSync(join(vellumDir, "feature-flag-token"), FEATURE_FLAG_TOKEN);

  // Write a minimal config.json so the feature-flags handler can read it
  writeFileSync(
    join(vellumDir, "workspace", "config.json"),
    JSON.stringify({ assistantFeatureFlagValues: { [FLAG_KEY]: true } }),
  );

  const defaultsPath = join(tmpDir, "assistant-feature-flag-defaults.json");
  writeFileSync(
    defaultsPath,
    JSON.stringify({
      [FLAG_KEY]: {
        defaultEnabled: true,
        description: "Hatch new assistant",
      },
    }),
  );
  process.env.FEATURE_FLAG_DEFAULTS_PATH = defaultsPath;

  // Set environment so loadConfig picks up our temp directory
  process.env.BASE_DATA_DIR = tmpDir;
  // Prevent env vars from overriding file-based tokens
  delete process.env.RUNTIME_BEARER_TOKEN;
  delete process.env.RUNTIME_PROXY_BEARER_TOKEN;
  delete process.env.FEATURE_FLAG_TOKEN;
  delete process.env.FEATURE_FLAG_TOKEN_PATH;
  delete process.env.VELLUM_HTTP_TOKEN_PATH;

  // Import after env is set so loadConfig reads our temp files
  const { loadConfig } = await import("./config.js");
  const { validateBearerToken } = await import("./http/auth/bearer.js");
  const { resetFeatureFlagDefaultsCache } = await import("./feature-flag-defaults.js");
  const { createFeatureFlagsGetHandler, createFeatureFlagsPatchHandler } =
    await import("./http/routes/feature-flags.js");
  resetFeatureFlagDefaultsCache();

  const config = loadConfig();
  const handleFeatureFlagsGet = createFeatureFlagsGetHandler();
  const handleFeatureFlagsPatch = createFeatureFlagsPatchHandler();

  // Verify tokens loaded correctly
  if (config.runtimeBearerToken !== RUNTIME_TOKEN) {
    throw new Error(
      `Expected runtimeBearerToken to be "${RUNTIME_TOKEN}", got "${config.runtimeBearerToken}"`,
    );
  }
  if (config.featureFlagToken !== FEATURE_FLAG_TOKEN) {
    throw new Error(
      `Expected featureFlagToken to be "${FEATURE_FLAG_TOKEN}", got "${config.featureFlagToken}"`,
    );
  }

  // Start a minimal Bun server that replicates only the feature-flag auth
  // routing from index.ts (avoids starting the full gateway with all its
  // side effects like Telegram reconciliation and credential watchers).
  server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);

      // GET /v1/feature-flags — accepts either token
      if (url.pathname === "/v1/feature-flags" && req.method === "GET") {
        if (!config.runtimeBearerToken && !config.featureFlagToken) {
          return Response.json(
            { error: "Service not configured: bearer token required" },
            { status: 503 },
          );
        }
        const authHeader = req.headers.get("authorization");
        let authorized = false;
        if (config.runtimeBearerToken) {
          const runtimeAuth = validateBearerToken(authHeader, config.runtimeBearerToken);
          if (runtimeAuth.authorized) authorized = true;
        }
        if (!authorized && config.featureFlagToken) {
          const flagAuth = validateBearerToken(authHeader, config.featureFlagToken);
          if (flagAuth.authorized) authorized = true;
        }
        if (!authorized) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return handleFeatureFlagsGet(req);
      }

      // PATCH /v1/feature-flags/:flagKey — requires feature-flag token
      const patchMatch = url.pathname.match(/^\/v1\/feature-flags\/(.+)$/);
      if (patchMatch && req.method === "PATCH") {
        if (!config.featureFlagToken) {
          return Response.json(
            { error: "Service not configured: feature-flag token required" },
            { status: 503 },
          );
        }

        // Explicitly reject runtime bearer token
        if (config.runtimeBearerToken) {
          const isRuntimeToken = validateBearerToken(
            req.headers.get("authorization"),
            config.runtimeBearerToken,
          );
          if (isRuntimeToken.authorized) {
            return Response.json(
              { error: "Forbidden: runtime token cannot be used for feature-flag mutations" },
              { status: 403 },
            );
          }
        }

        const authResult = validateBearerToken(
          req.headers.get("authorization"),
          config.featureFlagToken,
        );
        if (!authResult.authorized) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        let flagKey: string;
        try {
          flagKey = decodeURIComponent(patchMatch[1]);
        } catch {
          return Response.json({ error: "Invalid flag key encoding" }, { status: 400 });
        }
        return handleFeatureFlagsPatch(req, flagKey);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  const { resetFeatureFlagDefaultsCache } = await import("./feature-flag-defaults.js");
  resetFeatureFlagDefaultsCache();
  if (savedFeatureFlagDefaultsPath === undefined) {
    delete process.env.FEATURE_FLAG_DEFAULTS_PATH;
  } else {
    process.env.FEATURE_FLAG_DEFAULTS_PATH = savedFeatureFlagDefaultsPath;
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("PATCH /v1/feature-flags/:key auth", () => {
  test("rejects request with runtime bearer token (403)", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags/${FLAG_KEY}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${RUNTIME_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("runtime token");
  });

  test("succeeds with feature-flag client token", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags/${FLAG_KEY}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${FEATURE_FLAG_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe(FLAG_KEY);
    expect(body.enabled).toBe(true);
  });

  test("rejects request with no token (401)", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags/${FLAG_KEY}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong token (401)", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags/${FLAG_KEY}`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer totally-wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/feature-flags auth", () => {
  test("succeeds with runtime bearer token", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${RUNTIME_TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toBeDefined();
  });

  test("succeeds with feature-flag client token", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${FEATURE_FLAG_TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toBeDefined();
  });

  test("rejects request with no token (401)", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong token (401)", async () => {
    const res = await fetch(`${baseUrl}/v1/feature-flags`, {
      method: "GET",
      headers: {
        Authorization: "Bearer totally-wrong-token",
      },
    });
    expect(res.status).toBe(401);
  });
});
