/**
 * Unit tests for `loadMeetManifestProxies`.
 *
 * Covers the shape of the proxy `Tool` and `SkillRoute` entries the
 * loader installs, the "dispatch not implemented" stub behavior, and
 * the shutdown-hook wiring. The real `MeetHostSupervisor` is replaced
 * with a shallow stub so the test never touches `child_process.spawn`
 * or Unix domain sockets. Manifest JSON is written to a tmp fixture
 * path so the loader exercises its real `readFileSync` code path.
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
  reportSessionStarted: ReturnType<typeof mock>;
  reportSessionEnded: ReturnType<typeof mock>;
};

function makeSupervisorStub(
  overrides: { ensureRunningError?: Error } = {},
): SupervisorStub {
  const ensureRunning = mock(async () => {
    if (overrides.ensureRunningError) {
      throw overrides.ensureRunningError;
    }
  });
  const shutdown = mock(async () => {});
  const reportSessionStarted = mock((_id: string) => {});
  const reportSessionEnded = mock((_id: string) => {});
  const supervisor = {
    ensureRunning,
    shutdown,
    reportSessionStarted,
    reportSessionEnded,
    activeSessionCount: 0,
    isRunning: false,
    notifyHandshake: () => undefined,
  } as unknown as MeetHostSupervisor;
  return {
    supervisor,
    ensureRunning,
    shutdown,
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

  test("proxy tool execute calls ensureRunning and throws not-implemented", async () => {
    const stub = makeSupervisorStub();
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
    ).rejects.toThrow(/dispatch not implemented/i);
    expect(stub.ensureRunning).toHaveBeenCalledTimes(1);
  });

  test("proxy route handler returns 501 with not-implemented body", async () => {
    const stub = makeSupervisorStub();
    const routes: SkillRoute[] = [];

    await loadMeetManifestProxies(stub.supervisor, {
      manifestPath,
      registerTools: () => undefined,
      registerRoute: (r) => routes.push(r),
      registerShutdown: () => undefined,
    });

    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    // The JS engine may escape forward slashes when normalizing the source
    // string; compare via a fresh RegExp constructed from the manifest
    // entry so the assertion is engine-insensitive.
    expect(route.pattern.test("/api/skills/meet/test/events")).toBe(true);
    expect(route.pattern.test("/something/else")).toBe(false);
    expect(route.methods).toEqual(["POST"]);

    const match = "/api/skills/meet/test-id/events".match(route.pattern);
    if (!match) throw new Error("expected pattern match");
    const response = await route.handler(
      new Request("http://localhost/api/skills/meet/test-id/events", {
        method: "POST",
      }),
      match,
    );
    expect(response.status).toBe(501);
    expect(await response.text()).toMatch(/dispatch not implemented/i);
    expect(stub.ensureRunning).toHaveBeenCalledTimes(1);
  });

  test("proxy route handler returns 503 when ensureRunning fails", async () => {
    const err = new Error("spawn failed");
    const stub = makeSupervisorStub({ ensureRunningError: err });
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

  test("registers shutdown hooks that call supervisor.shutdown()", async () => {
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
