/**
 * Tests for permission mode SSE broadcast and HTTP endpoints.
 *
 * Verifies:
 *   - SSE `permission_mode_update` event is published on mode change
 *   - GET /v1/permission-mode returns current state (always available)
 *   - PUT /v1/permission-mode updates state and broadcasts (flag on)
 *   - PUT /v1/permission-mode returns 404 when flag is off
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

let mockFeatureFlagEnabled = false;

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => mockFeatureFlagEnabled,
  _setOverridesForTesting: () => {},
  clearFeatureFlagOverridesCache: () => {},
  getAssistantFeatureFlagDefaults: () => ({}),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    permissions: {
      askBeforeActing: true,
      hostAccess: false,
    },
  }),
  loadConfig: () => ({
    permissions: {
      askBeforeActing: true,
      hostAccess: false,
    },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Heavy dependency stubs — prevent settings-routes.ts transitive imports from
// reaching real OAuth orchestration, secure-key decryption, tool registry, etc.
// Only the permission-mode GET/PUT handlers are exercised in this file, so these
// stubs are never called.
mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
}));
mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => "http://localhost",
  setIngressPublicBaseUrl: () => {},
}));
mock.module("../daemon/handlers/config-ingress.js", () => ({
  computeGatewayTarget: () => "",
  getIngressConfigResult: () => ({}),
}));
mock.module("../daemon/handlers/config-voice.js", () => ({
  normalizeActivationKey: () => ({ ok: true, value: "" }),
}));
mock.module("../oauth/connect-orchestrator.js", () => ({
  orchestrateOAuthConnect: async () => ({ success: false, error: "stub" }),
}));
mock.module("../oauth/oauth-store.js", () => ({
  getApp: () => undefined,
  getConnectionByProvider: () => undefined,
  getMostRecentAppByProvider: () => undefined,
  getProvider: () => undefined,
}));
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
}));
mock.module("../skills/tool-manifest.js", () => ({
  parseToolManifestFile: () => ({ tools: [] }),
}));
mock.module("../tools/execution-target.js", () => ({
  resolveExecutionTarget: () => undefined,
}));
mock.module("../tools/registry.js", () => ({
  getAllTools: () => [],
  getTool: () => undefined,
}));
mock.module("../tools/schema-transforms.js", () => ({
  ACTIVITY_SKIP_SET: new Set(),
  injectActivityField: (defs: unknown[]) => defs,
}));
mock.module("../tools/side-effects.js", () => ({
  isSideEffectTool: () => false,
}));
mock.module("../tools/system/avatar-generator.js", () => ({
  generateAndSaveAvatar: async () => ({ isError: true, content: "stub" }),
}));
mock.module("../permissions/checker.js", () => ({
  check: async () => ({ decision: "allow", reason: "" }),
  classifyRisk: async () => "low",
  generateAllowlistOptions: async () => [],
  generateScopeOptions: () => [],
}));

afterAll(() => {
  mock.restore();
});

import {
  getMode,
  onModeChanged,
  resetForTesting,
  setAskBeforeActing,
  setHostAccess,
} from "../permissions/permission-mode-store.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { RouteDefinition } from "../runtime/http-router.js";
import { settingsRouteDefinitions } from "../runtime/routes/settings-routes.js";

// ---------------------------------------------------------------------------
// Route helpers — call actual route handlers
// ---------------------------------------------------------------------------

const routes = settingsRouteDefinitions();

function getRoute(method: string, endpoint: string): RouteDefinition {
  const route = routes.find(
    (r) => r.method === method && r.endpoint === endpoint,
  );
  if (!route) throw new Error(`Route not found: ${method} ${endpoint}`);
  return route;
}

function callPut(
  body: Record<string, unknown>,
): Promise<Response> | Response {
  const req = new Request("http://localhost/v1/permission-mode", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return getRoute("PUT", "permission-mode").handler({
    req,
    url: new URL(req.url),
    server: null as never,
    authContext: null as never,
    params: {},
  });
}

function callGet(): Promise<Response> | Response {
  const req = new Request("http://localhost/v1/permission-mode");
  return getRoute("GET", "permission-mode").handler({
    req,
    url: new URL(req.url),
    server: null as never,
    authContext: null as never,
    params: {},
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ensureTestDir();
  resetForTesting();
  mockFeatureFlagEnabled = false;
  // Remove config file to start clean
  try {
    rmSync(CONFIG_PATH, { force: true });
  } catch {
    /* noop */
  }
});

afterEach(() => {
  resetForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Permission mode SSE broadcast", () => {
  test("publishes permission_mode_update event when askBeforeActing changes", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: DAEMON_INTERNAL_ASSISTANT_ID }, (event) => {
      received.push(event);
    });

    // Wire up a listener that publishes to our test hub
    const { buildAssistantEvent } =
      await import("../runtime/assistant-event.js");
    onModeChanged((mode) => {
      void hub.publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "permission_mode_update",
          askBeforeActing: mode.askBeforeActing,
          hostAccess: mode.hostAccess,
        }),
      );
    });

    setAskBeforeActing(false);

    // Allow async publish to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0].message.type).toBe("permission_mode_update");
    const payload = received[0].message as {
      type: "permission_mode_update";
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(payload.askBeforeActing).toBe(false);
    expect(payload.hostAccess).toBe(false);
  });

  test("publishes permission_mode_update event when hostAccess changes", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: DAEMON_INTERNAL_ASSISTANT_ID }, (event) => {
      received.push(event);
    });

    const { buildAssistantEvent } =
      await import("../runtime/assistant-event.js");
    onModeChanged((mode) => {
      void hub.publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "permission_mode_update",
          askBeforeActing: mode.askBeforeActing,
          hostAccess: mode.hostAccess,
        }),
      );
    });

    setHostAccess(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0].message.type).toBe("permission_mode_update");
    const payload = received[0].message as {
      type: "permission_mode_update";
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(payload.askBeforeActing).toBe(true);
    expect(payload.hostAccess).toBe(true);
  });

  test("does not publish event when value is unchanged", async () => {
    const hub = new AssistantEventHub();
    const received: AssistantEvent[] = [];

    hub.subscribe({ assistantId: DAEMON_INTERNAL_ASSISTANT_ID }, (event) => {
      received.push(event);
    });

    const { buildAssistantEvent } =
      await import("../runtime/assistant-event.js");
    onModeChanged((mode) => {
      void hub.publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "permission_mode_update",
          askBeforeActing: mode.askBeforeActing,
          hostAccess: mode.hostAccess,
        }),
      );
    });

    // Default is askBeforeActing=true, setting to true is a no-op
    setAskBeforeActing(true);
    // Default is hostAccess=false, setting to false is a no-op
    setHostAccess(false);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(0);
  });
});

describe("GET /v1/permission-mode", () => {
  test("returns current permission mode state via route handler", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(body.askBeforeActing).toBe(true);
    expect(body.hostAccess).toBe(false);
  });

  test("returns updated state after mutation via route handler", async () => {
    setAskBeforeActing(false);
    setHostAccess(true);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(body.askBeforeActing).toBe(false);
    expect(body.hostAccess).toBe(true);
  });
});

describe("PUT /v1/permission-mode", () => {
  test("updates askBeforeActing via route handler when flag is enabled", async () => {
    mockFeatureFlagEnabled = true;

    const res = await callPut({ askBeforeActing: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(body.askBeforeActing).toBe(false);
    expect(body.hostAccess).toBe(false);
  });

  test("updates hostAccess via route handler when flag is enabled", async () => {
    mockFeatureFlagEnabled = true;

    const res = await callPut({ hostAccess: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(body.askBeforeActing).toBe(true);
    expect(body.hostAccess).toBe(true);
  });

  test("updates both axes independently via route handler", async () => {
    mockFeatureFlagEnabled = true;

    const res1 = await callPut({ askBeforeActing: false });
    expect(res1.status).toBe(200);

    const res2 = await callPut({ hostAccess: true });
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as {
      askBeforeActing: boolean;
      hostAccess: boolean;
    };
    expect(body.askBeforeActing).toBe(false);
    expect(body.hostAccess).toBe(true);
  });

  test("returns 404 when feature flag is off", async () => {
    mockFeatureFlagEnabled = false;

    const res = await callPut({ askBeforeActing: false });
    expect(res.status).toBe(404);

    // Verify the store was NOT mutated — askBeforeActing should remain at default
    const mode = getMode();
    expect(mode.askBeforeActing).toBe(true);
  });
});
