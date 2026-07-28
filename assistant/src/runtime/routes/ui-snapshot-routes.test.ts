/**
 * Tests for the staged UI-snapshot routes.
 *
 * Covers the full daemon-side round trip with a mocked event hub:
 * - no capable client → clean error (no pending interaction left behind)
 * - happy path: request broadcast to the targeted client, result POST
 *   resolves the blocked request with the PNG and theme context
 * - same-actor binding: a result from the wrong client is rejected
 * - timeout: cancel broadcast + timed_out error shape
 * - late delivery: a result for an unknown requestId is tolerated
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeClient {
  clientId: string;
  actorPrincipalId?: string;
}

let fakeClient: FakeClient | undefined;
const broadcasts: Array<{
  msg: Record<string, unknown>;
  targetClientId?: string;
}> = [];

mock.module("../assistant-event-hub.js", () => ({
  assistantEventHub: {
    getMostRecentClientByCapability: () => fakeClient,
    getActorPrincipalIdForClient: (clientId: string) =>
      fakeClient?.clientId === clientId
        ? fakeClient.actorPrincipalId
        : undefined,
  },
  broadcastMessage: (
    msg: Record<string, unknown>,
    _conversationId?: string,
    options?: { targetClientId?: string },
  ) => {
    broadcasts.push({ msg, targetClientId: options?.targetClientId });
  },
}));

const { ROUTES } = await import("./ui-snapshot-routes.js");

const snapshotRoute = ROUTES.find((r) => r.operationId === "ui_snapshot")!;
const resultRoute = ROUTES.find(
  (r) => r.operationId === "host_ui_snapshot_result",
)!;

const PNG_BASE64 = Buffer.from("fake-png-bytes").toString("base64");

let workspaceDir: string;
let originalWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "ui-snapshot-test-"));
  originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  fakeClient = undefined;
  broadcasts.length = 0;
});

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

function writeTheme(content: string): void {
  mkdirSync(join(workspaceDir, "ui"), { recursive: true });
  writeFileSync(join(workspaceDir, "ui", "theme.json"), content);
}

describe("ui_snapshot", () => {
  test("fails cleanly when no capable client is connected", async () => {
    const result = (await snapshotRoute.handler({
      body: { view: "sampler" },
    })) as { ok: boolean; error?: string; themeSource: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("desktop client");
    expect(result.themeSource).toBe("none");
    expect(broadcasts.length).toBe(0);
  });

  test("round trip: broadcasts the targeted request and resolves with the client's PNG", async () => {
    fakeClient = { clientId: "client-1", actorPrincipalId: "actor-1" };
    writeTheme(JSON.stringify({ version: 1, tokens: { accent: "#e8a04c" } }));

    const pending = snapshotRoute.handler({
      body: { view: "chat", timeoutMs: 5_000 },
    }) as Promise<{
      ok: boolean;
      pngBase64?: string;
      widthPx?: number;
      themeSource: string;
    }>;

    // The request event is broadcast synchronously at dispatch.
    expect(broadcasts.length).toBe(1);
    const request = broadcasts[0]!;
    expect(request.targetClientId).toBe("client-1");
    expect(request.msg.type).toBe("host_ui_snapshot_request");
    expect(request.msg.view).toBe("chat");
    expect(request.msg.tokens).toEqual({ accent: "#e8a04c" });

    const accepted = (await resultRoute.handler({
      body: {
        requestId: request.msg.requestId,
        pngBase64: PNG_BASE64,
        widthPx: 1440,
        heightPx: 1520,
      },
      headers: {
        "x-vellum-client-id": "client-1",
        "x-vellum-actor-principal-id": "actor-1",
      },
    })) as { accepted: boolean };
    expect(accepted.accepted).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.pngBase64).toBe(PNG_BASE64);
    expect(result.widthPx).toBe(1440);
    expect(result.themeSource).toBe("workspace");
  });

  test("rejects a result posted by a client other than the target", async () => {
    fakeClient = { clientId: "client-1", actorPrincipalId: "actor-1" };

    const pending = snapshotRoute.handler({
      body: { view: "sampler", timeoutMs: 5_000 },
    }) as Promise<{ ok: boolean }>;
    const requestId = broadcasts[0]!.msg.requestId;

    await expect(
      resultRoute.handler({
        body: { requestId, pngBase64: PNG_BASE64 },
        headers: {
          "x-vellum-client-id": "client-2",
          "x-vellum-actor-principal-id": "actor-2",
        },
      }),
    ).rejects.toThrow(/not the target/);

    // The legitimate client can still resolve it.
    await resultRoute.handler({
      body: { requestId, pngBase64: PNG_BASE64 },
      headers: {
        "x-vellum-client-id": "client-1",
        "x-vellum-actor-principal-id": "actor-1",
      },
    });
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  test("times out with a cancel broadcast when the client never responds", async () => {
    fakeClient = { clientId: "client-1", actorPrincipalId: "actor-1" };

    const result = (await snapshotRoute.handler({
      body: { view: "sampler", timeoutMs: 50 },
    })) as { ok: boolean; timedOut?: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("Timed out");
    const cancel = broadcasts.find(
      (b) => b.msg.type === "host_ui_snapshot_cancel",
    );
    expect(cancel).toBeDefined();
    expect(cancel!.targetClientId).toBe("client-1");
  });

  test("surfaces an invalid theme as themeSource invalid with issues, and omits tokens", async () => {
    fakeClient = { clientId: "client-1", actorPrincipalId: "actor-1" };
    writeTheme(JSON.stringify({ version: 1, tokens: { accent: "magenta" } }));

    const pending = snapshotRoute.handler({
      body: { view: "sampler", timeoutMs: 5_000 },
    }) as Promise<{ themeSource: string; themeIssues: string[] }>;

    const request = broadcasts[0]!;
    expect(request.msg.tokens).toBeUndefined();

    await resultRoute.handler({
      body: { requestId: request.msg.requestId, pngBase64: PNG_BASE64 },
      headers: {
        "x-vellum-client-id": "client-1",
        "x-vellum-actor-principal-id": "actor-1",
      },
    });

    const result = await pending;
    expect(result.themeSource).toBe("invalid");
    expect(result.themeIssues.length).toBeGreaterThan(0);
  });
});

describe("host_ui_snapshot_result", () => {
  test("tolerates late delivery for an unknown requestId", async () => {
    const result = (await resultRoute.handler({
      body: { requestId: "gone", pngBase64: PNG_BASE64 },
      headers: { "x-vellum-client-id": "client-1" },
    })) as { accepted: boolean };
    expect(result.accepted).toBe(true);
  });

  test("rejects a missing requestId", async () => {
    await expect(
      resultRoute.handler({ body: { pngBase64: PNG_BASE64 } }),
    ).rejects.toThrow(/requestId/);
  });
});
