/**
 * Tests for the POST /v1/acp/spawn route handler — focused on the three
 * failure paths produced by `resolveAcpAgent` (acp_disabled, unknown_agent,
 * binary_not_found). Mirrors the resolver's test setup using the shared
 * `installAcpConfigStub` and `installWhichStub` helpers so the host
 * environment doesn't influence the resolver's PATH preflight.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { installAcpConfigStub } from "../../acp/__tests__/helpers/acp-config-stub.js";
import { installWhichStub } from "../../acp/__tests__/helpers/which-stub.js";

const config = await installAcpConfigStub();
const which = installWhichStub();

afterAll(() => {
  which.restore();
});

const { acpRouteDefinitions } = await import("./acp-routes.js");

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
  config.setConfig({});
  which.setWhich((cmd) => `/usr/local/bin/${cmd}`);
});

// ---------------------------------------------------------------------------
// POST /v1/acp/spawn — failure paths from resolveAcpAgent
// ---------------------------------------------------------------------------

describe("POST /v1/acp/spawn", () => {
  test("returns 400 with the resolver hint when ACP is disabled", async () => {
    config.setConfig({ enabled: false });

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
    config.setConfig({
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

  test("returns 424 FAILED_DEPENDENCY with command + install hint when the agent binary is missing", async () => {
    config.setConfig({ agents: {} });
    which.setWhich({}); // no commands on PATH

    const handler = getSpawnHandler();
    const res = await handler(
      makeSpawnCtx({
        agent: "codex",
        task: "do a thing",
        conversationId: "conv-1",
      }),
    );

    expect(res.status).toBe(424);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("FAILED_DEPENDENCY");
    expect(body.error.message).toContain("codex-acp is not on PATH");
    // Same install hint the LLM tool surfaces.
    expect(body.error.message).toContain("npm i -g @zed-industries/codex-acp");
  });

  test("body-shape guard short-circuits before the resolver runs", async () => {
    // Disable ACP so a resolver-reached path would surface the disabled
    // hint — the body-shape error message must win, proving we short-circuit.
    config.setConfig({ enabled: false });

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
