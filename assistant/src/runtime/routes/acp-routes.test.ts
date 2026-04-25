/**
 * Tests for the POST /v1/acp/spawn route handler — focused on the three
 * failure paths produced by `resolveAcpAgent` (acp_disabled, unknown_agent,
 * binary_not_found). Mirrors the resolver's test setup: stubs `getConfig`
 * via `mock.module` and swaps `Bun.which` to deterministically simulate
 * binary presence/absence without touching the host environment.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AcpAgentConfig } from "../../config/acp-schema.js";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

interface MockAcpConfig {
  enabled: boolean;
  maxConcurrentSessions: number;
  agents: Record<string, AcpAgentConfig>;
}

let mockAcpConfig: MockAcpConfig = {
  enabled: true,
  maxConcurrentSessions: 4,
  agents: {},
};

// Spread the real loader's named exports so transitive importers that pull
// `loadConfig`, `invalidateConfigCache`, etc. from the same module path
// still resolve at parse time. Bun's `mock.module` is process-global and
// returns *exactly* the keys the factory returns — without the spread,
// any module the test pulls in transitively that does
// `import { loadConfig } from "../config/loader.js"` errors at evaluation
// time on "Export named 'loadConfig' not found".
const realLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => ({ acp: mockAcpConfig }),
}));

// `Bun.which` is a global, not an ESM module export — `mock.module` cannot
// touch it. Capture the original and restore in afterAll so the swap doesn't
// leak into other test files.
const originalWhich = Bun.which;
let whichStub: (command: string) => string | null = (cmd) =>
  `/usr/local/bin/${cmd}`;
(Bun as unknown as { which: (cmd: string) => string | null }).which = (cmd) =>
  whichStub(cmd);

afterAll(() => {
  (Bun as unknown as { which: typeof originalWhich }).which = originalWhich;
});

const { acpRouteDefinitions } = await import("./acp-routes.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setConfig(partial: Partial<MockAcpConfig>): void {
  mockAcpConfig = {
    enabled: true,
    maxConcurrentSessions: 4,
    agents: {},
    ...partial,
  };
}

function setWhich(map: Record<string, string | null>): void {
  whichStub = (cmd) => map[cmd] ?? null;
}

function getSpawnHandler() {
  const route = acpRouteDefinitions().find(
    (r) => r.endpoint === "acp/spawn" && r.method === "POST",
  );
  if (!route) throw new Error("acp/spawn route not registered");
  return route.handler;
}

function makeSpawnCtx(body: unknown) {
  const url = new URL("http://localhost/v1/acp/spawn");
  return {
    url,
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    server: {} as ReturnType<typeof Bun.serve>,
    authContext: {} as never,
    params: {},
  };
}

beforeEach(() => {
  setConfig({});
  whichStub = (cmd) => `/usr/local/bin/${cmd}`;
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — failure paths from resolveAcpAgent
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn", () => {
  test("returns 400 with the resolver hint when ACP is disabled", async () => {
    setConfig({ enabled: false });

    const handler = getSpawnHandler();
    const res = await handler(
      makeSpawnCtx({
        agent: "claude",
        task: "do a thing",
        conversationId: "conv-1",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("acp.enabled");
    expect(body.error.message).toContain("config.json");
  });

  test("returns 400 with merged available list when agent id is unknown", async () => {
    setConfig({
      agents: {
        "user-only": { command: "some-binary", args: [] },
      },
    });

    const handler = getSpawnHandler();
    const res = await handler(
      makeSpawnCtx({
        agent: "nonexistent",
        task: "do a thing",
        conversationId: "conv-1",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain('Unknown agent "nonexistent"');
    expect(body.error.message).toContain(
      "Available: claude, codex, user-only.",
    );
  });

  test("returns 400 with command + install hint when the agent binary is missing", async () => {
    setConfig({ agents: {} });
    setWhich({}); // no commands on PATH

    const handler = getSpawnHandler();
    const res = await handler(
      makeSpawnCtx({
        agent: "codex",
        task: "do a thing",
        conversationId: "conv-1",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("codex-acp is not on PATH");
    // Same install hint the LLM tool surfaces.
    expect(body.error.message).toContain("npm i -g @zed-industries/codex-acp");
  });

  test("body-shape guard short-circuits before the resolver runs", async () => {
    // Disable ACP so a resolver-reached path would surface the disabled
    // hint — the body-shape error message must win, proving we short-circuit.
    setConfig({ enabled: false });

    const handler = getSpawnHandler();
    const res = await handler(makeSpawnCtx({ agent: "claude" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toContain(
      "agent, task, and conversationId are required",
    );
  });
});
