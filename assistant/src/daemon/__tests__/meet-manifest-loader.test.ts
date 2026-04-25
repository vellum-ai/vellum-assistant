/**
 * Unit tests for `loadMeetManifestProxies`.
 *
 * Covers the shape of the proxy `Tool` and `SkillRoute` entries the
 * loader installs, the live dispatch behaviour (calls
 * `supervisor.dispatchTool/Route/Shutdown` and surfaces the result),
 * and the shutdown-hook wiring. The real `MeetHostSupervisor` is
 * replaced with a shallow stub so the test never touches
 * `child_process.spawn` or Unix domain sockets. Manifest JSON is
 * written to a tmp fixture path so the loader exercises its real
 * `readFileSync` code path.
 */

import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SkillRoute } from "../../runtime/skill-route-registry.js";
import { RiskLevel, type Tool } from "../../tools/types.js";
import type { MeetHostSupervisor } from "../meet-host-supervisor.js";
import {
  loadMeetManifestFromDisk,
  loadMeetManifestProxies,
} from "../meet-manifest-loader.js";

// ---------------------------------------------------------------------------
// Fixture manifest + supervisor stub
// ---------------------------------------------------------------------------

const FIXTURE_MANIFEST = {
  skill: "meet-join",
  sourceHash: "a".repeat(64),
  tools: [
    {
      name: "meet_demo",
      description: "Fixture demo tool",
      category: "meet",
      risk: "medium",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  ],
  routes: [
    {
      pattern: "^/api/skills/meet/([^/]+)/events$",
      methods: ["POST"],
    },
  ],
  shutdownHooks: ["meet-host-shutdown"],
};

type SupervisorStub = {
  supervisor: MeetHostSupervisor;
  ensureRunning: ReturnType<typeof mock>;
  shutdown: ReturnType<typeof mock>;
  dispatchTool: ReturnType<typeof mock>;
  dispatchRoute: ReturnType<typeof mock>;
  dispatchShutdown: ReturnType<typeof mock>;
  reportSessionStarted: ReturnType<typeof mock>;
  reportSessionEnded: ReturnType<typeof mock>;
};

interface SupervisorOverrides {
  dispatchToolResult?: unknown;
  dispatchToolError?: Error;
  dispatchRouteResult?: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  dispatchRouteError?: Error;
  dispatchShutdownError?: Error;
}

function makeSupervisorStub(
  overrides: SupervisorOverrides = {},
): SupervisorStub {
  const ensureRunning = mock(async () => {});
  const shutdown = mock(async () => {});
  const dispatchTool = mock(async () => {
    if (overrides.dispatchToolError) throw overrides.dispatchToolError;
    return overrides.dispatchToolResult ?? { ok: true };
  });
  const dispatchRoute = mock(async () => {
    if (overrides.dispatchRouteError) throw overrides.dispatchRouteError;
    return (
      overrides.dispatchRouteResult ?? {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "skill-handled",
      }
    );
  });
  const dispatchShutdown = mock(async () => {
    if (overrides.dispatchShutdownError) throw overrides.dispatchShutdownError;
  });
  const reportSessionStarted = mock((_id: string) => {});
  const reportSessionEnded = mock((_id: string) => {});
  const supervisor = {
    ensureRunning,
    shutdown,
    dispatchTool,
    dispatchRoute,
    dispatchShutdown,
    reportSessionStarted,
    reportSessionEnded,
    activeSessionCount: 0,
    isRunning: false,
    notifyHandshake: () => undefined,
    setActiveConnection: () => undefined,
    clearActiveConnection: () => undefined,
  } as unknown as MeetHostSupervisor;
  return {
    supervisor,
    ensureRunning,
    shutdown,
    dispatchTool,
    dispatchRoute,
    dispatchShutdown,
    reportSessionStarted,
    reportSessionEnded,
  };
}

// ---------------------------------------------------------------------------
// Tmp-dir fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "meet-manifest-loader-"));
  manifestPath = join(tmpDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(FIXTURE_MANIFEST, null, 2),
    "utf8",
  );
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadMeetManifestProxies", () => {
  test("registers a lazy tool provider that returns exactly the manifest tools", async () => {
    const { supervisor } = makeSupervisorStub();
    const capturedProviders: Array<() => Tool[]> = [];
    const capturedRoutes: SkillRoute[] = [];
    const capturedHooks: string[] = [];

    await loadMeetManifestProxies(supervisor, {
      manifestPath,
      registerTools: (p) => capturedProviders.push(p),
      registerRoute: (r) => capturedRoutes.push(r),
      registerShutdown: (name) => capturedHooks.push(name),
    });

    expect(capturedProviders).toHaveLength(1);
    const tools = capturedProviders[0]!();
    expect(tools).toHaveLength(1);
    const t = tools[0]!;
    expect(t.name).toBe("meet_demo");
    expect(t.description).toBe("Fixture demo tool");
    expect(t.category).toBe("meet");
    expect(t.defaultRiskLevel).toBe(RiskLevel.Medium);
    expect(t.executionMode).toBe("proxy");
    expect(t.origin).toBe("skill");
    expect(t.ownerSkillId).toBe("meet-join");
    expect(t.ownerSkillBundled).toBe(true);
    expect(t.ownerSkillVersionHash).toBe(FIXTURE_MANIFEST.sourceHash);
    expect(t.getDefinition().input_schema).toEqual(
      FIXTURE_MANIFEST.tools[0]!.input_schema,
    );
  });

  test("proxy tool execute dispatches through supervisor.dispatchTool and returns the result", async () => {
    const stub = makeSupervisorStub({
      dispatchToolResult: { joinUrl: "https://example.test/m/abc" },
    });
    const captured: Array<() => Tool[]> = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: (p) => captured.push(p),
      registerRoute: () => undefined,
      registerShutdown: () => undefined,
    });

    const tool = captured[0]!()[0]!;
    const result = await tool.execute(
      { url: "https://example.test/meet/x" },
      {
        workingDir: "/tmp",
        conversationId: "conv-xyz",
        trustClass: "guardian",
        assistantId: "self",
      },
    );

    expect(result as unknown).toEqual({
      joinUrl: "https://example.test/m/abc",
    });
    expect(stub.dispatchTool).toHaveBeenCalledTimes(1);
    const call = stub.dispatchTool.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe("meet_demo");
    expect(call[1]).toEqual({ url: "https://example.test/meet/x" });
    // The serialized context should carry conversationId and trustClass at
    // minimum so meet-join's tools can read them on the skill side.
    expect(call[2].conversationId).toBe("conv-xyz");
    expect(call[2].trustClass).toBe("guardian");
    expect(call[2].assistantId).toBe("self");
  });

  test("proxy tool execute propagates supervisor.dispatchTool errors", async () => {
    const stub = makeSupervisorStub({
      dispatchToolError: new Error("remote tool exploded"),
    });
    const captured: Array<() => Tool[]> = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: (p) => captured.push(p),
      registerRoute: () => undefined,
      registerShutdown: () => undefined,
    });

    const tool = captured[0]!()[0]!;
    await expect(
      tool.execute(
        { url: "https://example.test/meet/x" },
        {
          workingDir: "/tmp",
          conversationId: "c",
          trustClass: "guardian",
        },
      ),
    ).rejects.toThrow(/remote tool exploded/);
  });

  test("proxy route handler dispatches through supervisor.dispatchRoute and materializes the response", async () => {
    const stub = makeSupervisorStub({
      dispatchRouteResult: {
        status: 202,
        headers: { "content-type": "application/json", "x-skill": "meet" },
        body: '{"received":true}',
      },
    });
    const routes: SkillRoute[] = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: () => undefined,
      registerRoute: (r) => routes.push(r),
      registerShutdown: () => undefined,
    });

    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.methods).toEqual(["POST"]);

    const match = "/api/skills/meet/test-id/events".match(route.pattern);
    if (!match) throw new Error("expected pattern match");
    const response = await route.handler(
      new Request("http://localhost/api/skills/meet/test-id/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"hello":"world"}',
      }),
      match,
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"received":true}');
    expect(response.headers.get("x-skill")).toBe("meet");

    expect(stub.dispatchRoute).toHaveBeenCalledTimes(1);
    const call = stub.dispatchRoute.mock.calls[0] as [
      string,
      {
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ];
    expect(call[0]).toBe("^/api/skills/meet/([^/]+)/events$");
    expect(call[1].method).toBe("POST");
    expect(call[1].url).toBe("http://localhost/api/skills/meet/test-id/events");
    expect(call[1].body).toBe('{"hello":"world"}');
    expect(call[1].headers?.["content-type"]).toBe("application/json");
  });

  test("proxy route handler returns 503 when supervisor.dispatchRoute throws", async () => {
    const stub = makeSupervisorStub({
      dispatchRouteError: new Error("connection lost"),
    });
    const routes: SkillRoute[] = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: () => undefined,
      registerRoute: (r) => routes.push(r),
      registerShutdown: () => undefined,
    });

    const route = routes[0]!;
    const match = "/api/skills/meet/x/events".match(route.pattern);
    if (!match) throw new Error("expected pattern match");
    const response = await route.handler(
      new Request("http://localhost/api/skills/meet/x/events", {
        method: "POST",
      }),
      match,
    );
    expect(response.status).toBe(503);
  });

  test("registers shutdown hooks that dispatch the named hook and tear down the supervisor", async () => {
    const stub = makeSupervisorStub();
    const hooks: Array<{
      name: string;
      run: (reason: string) => Promise<void>;
    }> = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: () => undefined,
      registerRoute: () => undefined,
      registerShutdown: (name, hook) => {
        hooks.push({ name, run: hook });
      },
    });

    expect(hooks.map((h) => h.name)).toEqual(["meet-host-shutdown"]);
    await hooks[0]!.run("daemon-shutdown");
    expect(stub.dispatchShutdown).toHaveBeenCalledTimes(1);
    const call = stub.dispatchShutdown.mock.calls[0] as [string, string];
    expect(call[0]).toBe("meet-host-shutdown");
    expect(call[1]).toBe("daemon-shutdown");
    expect(stub.shutdown).toHaveBeenCalledTimes(1);
  });

  test("shutdown hook still tears down the supervisor when dispatchShutdown fails", async () => {
    const stub = makeSupervisorStub({
      dispatchShutdownError: new Error("connection gone"),
    });
    const hooks: Array<{
      name: string;
      run: (reason: string) => Promise<void>;
    }> = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: () => undefined,
      registerRoute: () => undefined,
      registerShutdown: (name, hook) => {
        hooks.push({ name, run: hook });
      },
    });

    await hooks[0]!.run("daemon-shutdown");
    expect(stub.dispatchShutdown).toHaveBeenCalledTimes(1);
    expect(stub.shutdown).toHaveBeenCalledTimes(1);
  });

  test("throws a clear error when the manifest file is missing", async () => {
    const stub = makeSupervisorStub();
    const missing = join(tmpDir, "does-not-exist.json");
    await expect(
      loadMeetManifestProxies(stub.supervisor, {
        manifestPath: missing,
        registerTools: () => undefined,
        registerRoute: () => undefined,
        registerShutdown: () => undefined,
      }),
    ).rejects.toThrow(/rebuild\/repackage/);
  });

  test("rejects a manifest whose skill field does not match meet-join", async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...FIXTURE_MANIFEST, skill: "other-skill" }, null, 2),
      "utf8",
    );
    const stub = makeSupervisorStub();
    await expect(
      loadMeetManifestProxies(stub.supervisor, {
        manifestPath,
        registerTools: () => undefined,
        registerRoute: () => undefined,
        registerShutdown: () => undefined,
      }),
    ).rejects.toThrow(/skill field/);
  });
});

describe("loadMeetManifestFromDisk", () => {
  test("parses a valid manifest and returns sourceHash", () => {
    const result = loadMeetManifestFromDisk(manifestPath);
    expect(result.skill).toBe("meet-join");
    expect(result.sourceHash).toBe(FIXTURE_MANIFEST.sourceHash);
    expect(result.tools).toHaveLength(1);
    expect(result.routes).toHaveLength(1);
    expect(result.shutdownHooks).toEqual(["meet-host-shutdown"]);
  });

  test("rejects malformed JSON", () => {
    writeFileSync(manifestPath, "{not json", "utf8");
    expect(() => loadMeetManifestFromDisk(manifestPath)).toThrow(
      /not valid JSON/,
    );
  });
});
