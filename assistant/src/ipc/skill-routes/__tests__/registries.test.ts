/**
 * Handler-level tests for the host.registries.* IPC routes.
 *
 * Each test invokes the route handler directly rather than going through
 * the socket round-trip so assertions can observe the in-process registry
 * side-effects (proxy tools in the tool registry, skill routes in the HTTP
 * registry, shutdown hooks in the shutdown registry). Socket-level
 * integration is covered by `ipc/__tests__/skill-server.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runShutdownHooks } from "../../../daemon/shutdown-registry.js";
import {
  matchSkillRoute,
  resetSkillRoutesForTests,
} from "../../../runtime/skill-route-registry.js";
import {
  __clearExternalToolProvidersForTesting,
  __clearRegistryForTesting,
  getTool,
  getToolOwner,
} from "../../../tools/registry.js";
import { RiskLevel } from "../../../tools/types.js";
import {
  __getActiveSessionCountForTesting,
  __resetActiveSessionsForTesting,
  registerShutdownHookRoute,
  registerSkillRouteRoute,
  registerToolsRoute,
  reportSessionEndedRoute,
  reportSessionStartedRoute,
  setMeetHostSupervisorForSessionReports,
} from "../registries.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  __clearRegistryForTesting();
  __clearExternalToolProvidersForTesting();
  resetSkillRoutesForTests();
  __resetActiveSessionsForTesting();
});

afterEach(() => {
  __clearRegistryForTesting();
  __clearExternalToolProvidersForTesting();
  resetSkillRoutesForTests();
  __resetActiveSessionsForTesting();
});

// ---------------------------------------------------------------------------
// host.registries.register_tools
// ---------------------------------------------------------------------------

describe("host.registries.register_tools", () => {
  test("installs proxy tools into the daemon's external tool registry", async () => {
    // `skillId` lives at the top of the params object (one frame = one
    // skill's batch). The per-tool manifest schema no longer carries an
    // `owner` field — ownership flows in through this top-level key and
    // is recorded in the registry's `ownersByName` map.
    const result = (await registerToolsRoute.handler({
      skillId: "demo-skill",
      tools: [
        {
          name: "skill_demo_tool",
          description: "demo tool",
          input_schema: { type: "object", properties: {} },
          defaultRiskLevel: "low",
          category: "skill",
          executionTarget: "sandbox",
        },
      ],
    })) as { registered: string[] };

    expect(result.registered).toEqual(["skill_demo_tool"]);
    const installed = getTool("skill_demo_tool");
    expect(installed).toBeDefined();
    // Ownership lives on the registry — getToolOwner is the single source of
    // truth. The Tool object itself no longer carries the kind.
    expect(getToolOwner("skill_demo_tool")).toEqual({
      kind: "skill",
      id: "demo-skill",
    });
  });

  test("proxy execute surfaces an error result when no supervisor is attached", async () => {
    await registerToolsRoute.handler({
      skillId: "stub-skill",
      tools: [
        {
          name: "skill_stub_tool",
          description: "stub",
          input_schema: { type: "object" },
          defaultRiskLevel: "medium",
          category: "skill",
        },
      ],
    });

    const installed = getTool("skill_stub_tool");
    expect(installed).toBeDefined();
    // Skill tools arrive without an `execute` closure (closures don't cross
    // IPC). `finalizeTool` synthesizes a no-op error result so unsupervised
    // invocations surface a clear "not wired up" signal to the model.
    const result = await installed!.execute(
      {},
      {
        workingDir: "/tmp",
        conversationId: "c",
        trustClass: "guardian",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no execute implementation/i);
  });

  test("rejects empty tool list", async () => {
    await expect(
      registerToolsRoute.handler({ skillId: "any-skill", tools: [] }),
    ).rejects.toThrow();
  });

  test("fills defaults for partial tool entries", async () => {
    // Wire and author share one schema (`ToolDefinitionSchema`, all-optional)
    // and the daemon runs `finalizeTool` on every incoming tool. So a
    // partial entry doesn't reject — defaults fill in for missing fields.
    const result = (await registerToolsRoute.handler({
      skillId: "partial-skill",
      tools: [{ name: "partial_tool" }],
    })) as { registered: string[] };
    expect(result.registered).toEqual(["partial_tool"]);
    const installed = getTool("partial_tool");
    expect(installed).toBeDefined();
    expect(installed!.defaultRiskLevel).toBe(RiskLevel.Medium);
    expect(installed!.executionTarget).toBe("sandbox");
  });

  test("rejects missing skillId", async () => {
    // skillId is the only place ownership flows in over IPC — without it
    // the registry can't claim the tools, so the handler must reject.
    await expect(
      registerToolsRoute.handler({
        tools: [
          {
            name: "skill_orphan_tool",
            description: "no owner",
            input_schema: { type: "object" },
            defaultRiskLevel: "low",
            category: "skill",
          },
        ],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// host.registries.register_skill_route
// ---------------------------------------------------------------------------

describe("host.registries.register_skill_route", () => {
  test("installs a proxy route visible to matchSkillRoute", async () => {
    const result = (await registerSkillRouteRoute.handler({
      patternSource: "^/skill/demo$",
      methods: ["GET", "POST"],
    })) as { patternSource: string; methods: string[] };
    expect(result.patternSource).toBe("^/skill/demo$");
    expect(result.methods).toEqual(["GET", "POST"]);

    const match = matchSkillRoute("/skill/demo", "POST");
    expect(match).not.toBeNull();
    expect(match?.kind).toBe("match");
  });

  test("proxy handler returns 501 until PR 28 dispatch lands", async () => {
    await registerSkillRouteRoute.handler({
      patternSource: "^/skill/stub$",
      methods: ["GET"],
    });

    const match = matchSkillRoute("/skill/stub", "GET");
    if (match?.kind !== "match") throw new Error("expected match");
    const response = await match.route.handler(
      new Request("http://localhost/skill/stub"),
      match.match,
    );
    expect(response.status).toBe(501);
  });

  test("rejects malformed regex source", async () => {
    await expect(
      registerSkillRouteRoute.handler({
        patternSource: "[unterminated",
        methods: ["GET"],
      }),
    ).rejects.toThrow(/Invalid skill-route pattern/);
  });

  test("rejects empty methods list", async () => {
    await expect(
      registerSkillRouteRoute.handler({
        patternSource: "^/x$",
        methods: [],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// host.registries.register_shutdown_hook
// ---------------------------------------------------------------------------

describe("host.registries.register_shutdown_hook", () => {
  test("registers a hook that runs on runShutdownHooks", async () => {
    // Register a sibling hook that records invocation so we can assert the
    // runShutdownHooks walk reached our newly registered entry.
    const { registerShutdownHook } =
      await import("../../../daemon/shutdown-registry.js");
    let sentinelRan = false;
    registerShutdownHook("pr24-test-sentinel", async () => {
      sentinelRan = true;
    });

    const result = (await registerShutdownHookRoute.handler({
      name: "pr24-test-hook",
    })) as { name: string };
    expect(result.name).toBe("pr24-test-hook");

    await runShutdownHooks("test-shutdown");
    expect(sentinelRan).toBe(true);
  });

  test("rejects missing name", async () => {
    await expect(
      registerShutdownHookRoute.handler({ name: "" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// host.registries.report_session_started / report_session_ended
// ---------------------------------------------------------------------------

describe("host.registries.report_session_{started,ended}", () => {
  test("started increments, ended decrements, duplicate-aware", async () => {
    expect(__getActiveSessionCountForTesting()).toBe(0);

    let result = (await reportSessionStartedRoute.handler({
      meetingId: "meet-a",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(1);

    // Duplicate started for the same meeting should be idempotent.
    result = (await reportSessionStartedRoute.handler({
      meetingId: "meet-a",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(1);

    result = (await reportSessionStartedRoute.handler({
      meetingId: "meet-b",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(2);

    result = (await reportSessionEndedRoute.handler({
      meetingId: "meet-a",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(1);

    // Ending a never-started meeting is a no-op.
    result = (await reportSessionEndedRoute.handler({
      meetingId: "meet-unknown",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(1);

    result = (await reportSessionEndedRoute.handler({
      meetingId: "meet-b",
    })) as { activeCount: number };
    expect(result.activeCount).toBe(0);
  });

  test("rejects missing meetingId", async () => {
    await expect(
      reportSessionStartedRoute.handler({ meetingId: "" }),
    ).rejects.toThrow();
    await expect(
      reportSessionEndedRoute.handler({ meetingId: "" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lazy-external short-circuit (PR D)
//
// When a `MeetHostSupervisor` is registered via
// `setMeetHostSupervisorForSessionReports`, the manifest loader has
// already installed proxy tools/routes/shutdown hooks. The IPC handlers
// must NOT re-install duplicates — they should just pin the incoming
// connection on the supervisor and return a sensible ack frame.
// ---------------------------------------------------------------------------

describe("lazy-external short-circuit", () => {
  type CapturedConnection = {
    connectionId: string;
    addRouteHandle: () => void;
    addSkillToolsOwner: () => void;
  };

  function makeFakeConnection(id = "conn-test"): CapturedConnection {
    return {
      connectionId: id,
      addRouteHandle: () => undefined,
      addSkillToolsOwner: () => undefined,
    };
  }

  function makeStubSupervisor(): {
    supervisor: Parameters<typeof setMeetHostSupervisorForSessionReports>[0];
    setActiveCalls: CapturedConnection[];
  } {
    const setActiveCalls: CapturedConnection[] = [];
    const supervisor = {
      reportSessionStarted: () => undefined,
      reportSessionEnded: () => undefined,
      activeSessionCount: 0,
      setActiveConnection: (conn: CapturedConnection) => {
        setActiveCalls.push(conn);
      },
    } as unknown as Parameters<
      typeof setMeetHostSupervisorForSessionReports
    >[0];
    return { supervisor, setActiveCalls };
  }

  test("register_tools skips in-memory registration and pins connection", async () => {
    const { supervisor, setActiveCalls } = makeStubSupervisor();
    setMeetHostSupervisorForSessionReports(supervisor);
    const conn = makeFakeConnection();

    const result = (await registerToolsRoute.handler(
      {
        skillId: "demo-skill",
        tools: [
          {
            name: "skill_demo_tool",
            description: "demo",
            input_schema: {},
            defaultRiskLevel: "low",
            category: "skill",
          },
        ],
      },
      conn,
    )) as { registered: string[] };

    expect(result.registered).toEqual(["skill_demo_tool"]);
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0]?.connectionId).toBe(conn.connectionId);
    // Tool should NOT have been installed into the in-memory registry —
    // the manifest loader already owns that side.
    expect(getTool("skill_demo_tool")).toBeUndefined();
  });

  test("register_skill_route skips in-memory registration and pins connection", async () => {
    const { supervisor, setActiveCalls } = makeStubSupervisor();
    setMeetHostSupervisorForSessionReports(supervisor);
    const conn = makeFakeConnection("route-conn");

    const result = (await registerSkillRouteRoute.handler(
      {
        patternSource: "^/skill/lazy$",
        methods: ["GET"],
      },
      conn,
    )) as { patternSource: string; methods: string[] };

    expect(result.patternSource).toBe("^/skill/lazy$");
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0]?.connectionId).toBe("route-conn");
    // Route should NOT have been installed in the route registry.
    expect(matchSkillRoute("/skill/lazy", "GET")).toBeNull();
  });

  test("register_shutdown_hook skips registration and pins connection", async () => {
    const { supervisor, setActiveCalls } = makeStubSupervisor();
    setMeetHostSupervisorForSessionReports(supervisor);
    const conn = makeFakeConnection("hook-conn");

    const result = (await registerShutdownHookRoute.handler(
      { name: "lazy-hook" },
      conn,
    )) as { name: string };

    expect(result.name).toBe("lazy-hook");
    expect(setActiveCalls).toHaveLength(1);
    expect(setActiveCalls[0]?.connectionId).toBe("hook-conn");
  });
});
