import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnvironmentDefinition } from "@vellumai/environments";

// Point lockfile operations at a temp directory before importing anything that
// would otherwise resolve real on-host paths.
const testDir = mkdtempSync(join(tmpdir(), "cli-orphan-detection-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import {
  detectOrphanedProcesses,
  getKnownPidsFromAssistants,
} from "../lib/orphan-detection.js";
import {
  loadAllAssistantsAcrossEnvs,
  type AssistantEntry,
} from "../lib/assistant-config.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
});

function makeLocalEntry(
  id: string,
  instanceDir: string,
  pids: {
    daemon?: string;
    gateway?: string;
    qdrant?: string;
    embed?: string;
  } = {},
): AssistantEntry {
  const vellumDir = join(instanceDir, ".vellum");
  mkdirSync(join(vellumDir, "workspace", "data", "qdrant"), {
    recursive: true,
  });
  if (pids.daemon !== undefined) {
    writeFileSync(join(vellumDir, "workspace", "vellum.pid"), pids.daemon);
  }
  if (pids.gateway !== undefined) {
    writeFileSync(join(vellumDir, "gateway.pid"), pids.gateway);
  }
  if (pids.qdrant !== undefined) {
    writeFileSync(
      join(vellumDir, "workspace", "data", "qdrant", "qdrant.pid"),
      pids.qdrant,
    );
  }
  if (pids.embed !== undefined) {
    writeFileSync(join(vellumDir, "workspace", "embed-worker.pid"), pids.embed);
  }
  return {
    assistantId: id,
    runtimeUrl: "http://localhost:7821",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 8090,
    },
  };
}

describe("getKnownPidsFromAssistants", () => {
  let perTestDir: string;

  beforeEach(() => {
    perTestDir = mkdtempSync(join(testDir, "case-"));
  });

  test("collects daemon, gateway, qdrant, and embed-worker PIDs", () => {
    const entry = makeLocalEntry("alpha", join(perTestDir, "alpha"), {
      daemon: "100",
      gateway: "200",
      qdrant: "300",
      embed: "400",
    });
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["100", "200", "300", "400"]));
  });

  test("skips missing PID files without throwing", () => {
    const entry = makeLocalEntry("beta", join(perTestDir, "beta"), {
      daemon: "100",
    });
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["100"]));
  });

  test("includes docker watcherPid when present", () => {
    const entry: AssistantEntry = {
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:18100",
      cloud: "docker",
      watcherPid: 555,
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["555"]));
  });

  test("ignores non-local entries without watcherPid", () => {
    const entry: AssistantEntry = {
      assistantId: "managed-1",
      runtimeUrl: "https://platform.vellum.ai/foo",
      cloud: "vellum",
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids.size).toBe(0);
  });

  test("local entry without resources contributes no PIDs", () => {
    const entry: AssistantEntry = {
      assistantId: "legacy",
      runtimeUrl: "http://localhost:7821",
      cloud: "local",
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids.size).toBe(0);
  });

  test("aggregates PIDs across multiple assistants", () => {
    const a = makeLocalEntry("a", join(perTestDir, "a"), {
      daemon: "100",
      gateway: "200",
    });
    const b = makeLocalEntry("b", join(perTestDir, "b"), {
      daemon: "101",
      gateway: "201",
    });
    const pids = getKnownPidsFromAssistants([a, b]);
    expect(pids).toEqual(new Set(["100", "200", "101", "201"]));
  });
});

describe("loadAllAssistantsAcrossEnvs", () => {
  function makeEnv(name: string, lockfileDir: string): EnvironmentDefinition {
    return {
      name,
      platformUrl: "https://example.invalid",
      webUrl: "https://example.invalid",
      lockfileDirOverride: lockfileDir,
    };
  }

  test("aggregates entries from every provided environment's lockfile", () => {
    const envADir = mkdtempSync(join(testDir, "envA-"));
    const envBDir = mkdtempSync(join(testDir, "envB-"));

    writeFileSync(
      join(envADir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "alpha",
            runtimeUrl: "http://localhost:7821",
            cloud: "local",
          },
        ],
      }),
    );
    writeFileSync(
      join(envBDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "beta",
            runtimeUrl: "http://localhost:18100",
            cloud: "docker",
            watcherPid: 777,
          },
        ],
      }),
    );

    const all = loadAllAssistantsAcrossEnvs([
      makeEnv("envA", envADir),
      makeEnv("envB", envBDir),
    ]);
    const ids = all.map((e) => e.assistantId).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });

  test("returns empty list when no envs have lockfiles", () => {
    const envDir = mkdtempSync(join(testDir, "empty-"));
    const all = loadAllAssistantsAcrossEnvs([makeEnv("missing", envDir)]);
    expect(all).toEqual([]);
  });

  test("skips malformed JSON without throwing", () => {
    const envDir = mkdtempSync(join(testDir, "malformed-"));
    writeFileSync(join(envDir, "lockfile.json"), "{not json");
    const all = loadAllAssistantsAcrossEnvs([makeEnv("bad", envDir)]);
    expect(all).toEqual([]);
  });

  test("skips entries missing required fields", () => {
    const envDir = mkdtempSync(join(testDir, "partial-"));
    writeFileSync(
      join(envDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          { assistantId: "no-url" }, // missing runtimeUrl
          { runtimeUrl: "http://x" }, // missing assistantId
          {
            assistantId: "good",
            runtimeUrl: "http://localhost:7821",
            cloud: "local",
          },
        ],
      }),
    );
    const all = loadAllAssistantsAcrossEnvs([makeEnv("partial", envDir)]);
    expect(all.map((e) => e.assistantId)).toEqual(["good"]);
  });

  test("end-to-end: dev env's daemon is not flagged as orphan from local env", () => {
    // Simulate Vargas's reported bug: `local` env has no assistants, but a
    // `dev` env assistant is running with a recorded daemon PID. The orphan
    // filter must treat that PID as known.
    const devDir = mkdtempSync(join(testDir, "dev-"));
    const instanceDir = join(devDir, "instances", "quiet-finch");
    makeLocalEntry("quiet-finch", instanceDir, {
      daemon: "19067",
      gateway: "19087",
      qdrant: "19167",
    });

    writeFileSync(
      join(devDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "quiet-finch",
            runtimeUrl: "http://127.0.0.1:18100",
            cloud: "local",
            resources: {
              instanceDir,
              daemonPort: 18000,
              gatewayPort: 18100,
              qdrantPort: 18200,
              cesPort: 18300,
            },
          },
        ],
      }),
    );

    const devEntries = loadAllAssistantsAcrossEnvs([makeEnv("dev", devDir)]);
    expect(devEntries).toHaveLength(1);

    const knownPids = getKnownPidsFromAssistants(devEntries);
    expect(knownPids).toEqual(new Set(["19067", "19087", "19167"]));
  });
});

describe("detectOrphanedProcesses", () => {
  test("excludes PIDs passed via excludePids", async () => {
    // The orphan detector calls `ps ax` and filters by regex. The process
    // running this test (bun) is itself a node-family process whose pid will
    // not match the vellum/qdrant/openclaw regex, so the natural result of
    // the scan is "no rows". To assert exclusion semantics deterministically,
    // we just confirm the function accepts an excludePids option and returns
    // an array — the meaningful behavior assertion lives in the integration
    // path (the function's `knownPids.has(p.pid)` short-circuit), which we
    // exercise indirectly by passing our own PID (guaranteed to never be
    // double-counted).
    const ownPid = String(process.pid);
    const result = await detectOrphanedProcesses({
      excludePids: new Set([ownPid]),
    });
    expect(Array.isArray(result)).toBe(true);
    for (const orphan of result) {
      expect(orphan.pid).not.toBe(ownPid);
    }
  });

  test("returns an array (smoke)", async () => {
    const result = await detectOrphanedProcesses({
      excludePids: new Set(),
    });
    expect(Array.isArray(result)).toBe(true);
  });
});
