import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point lockfile operations at a temp directory
const testDir = mkdtempSync(join(tmpdir(), "cli-assistant-config-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import {
  loadLatestAssistant,
  findAssistantByName,
  removeAssistantEntry,
  loadAllAssistants,
  saveAssistantEntry,
  getActiveAssistant,
  migrateLegacyEntry,
  type AssistantEntry,
} from "../lib/assistant-config.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
});

function writeLockfile(data: unknown): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(data, null, 2),
  );
}

const makeEntry = (
  id: string,
  runtimeUrl = "http://localhost:7821",
  extra?: Partial<AssistantEntry>,
): AssistantEntry => ({
  assistantId: id,
  runtimeUrl,
  cloud: "local",
  ...extra,
});

describe("assistant-config", () => {
  beforeEach(() => {
    // Reset lockfile between tests
    try {
      rmSync(join(testDir, ".vellum.lock.json"));
    } catch {
      // file may not exist
    }
    try {
      rmSync(join(testDir, ".vellum.lockfile.json"));
    } catch {
      // file may not exist
    }
  });

  test("loadAllAssistants returns empty array when no lockfile exists", () => {
    expect(loadAllAssistants()).toEqual([]);
  });

  test("loadAllAssistants returns empty array for malformed lockfile", () => {
    writeFileSync(join(testDir, ".vellum.lock.json"), "not json");
    expect(loadAllAssistants()).toEqual([]);
  });

  test("loadAllAssistants returns empty array when assistants key is missing", () => {
    writeLockfile({ someOtherKey: true });
    expect(loadAllAssistants()).toEqual([]);
  });

  test("saveAssistantEntry and loadAllAssistants round-trip", () => {
    const entry = makeEntry("test-1");
    saveAssistantEntry(entry);
    const all = loadAllAssistants();
    expect(all).toHaveLength(1);
    expect(all[0].assistantId).toBe("test-1");
  });

  test("findAssistantByName returns matching entry", () => {
    writeLockfile({
      assistants: [makeEntry("alpha"), makeEntry("beta")],
    });
    const result = findAssistantByName("beta");
    expect(result).not.toBeNull();
    expect(result!.assistantId).toBe("beta");
  });

  test("findAssistantByName returns null for non-existent name", () => {
    writeLockfile({ assistants: [makeEntry("alpha")] });
    expect(findAssistantByName("missing")).toBeNull();
  });

  test("removeAssistantEntry removes matching entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
    });
    removeAssistantEntry("b");
    const all = loadAllAssistants();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.assistantId)).toEqual(["a", "c"]);
  });

  test("removeAssistantEntry reassigns activeAssistant to remaining entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b")],
      activeAssistant: "a",
    });
    removeAssistantEntry("a");
    expect(getActiveAssistant()).toBe("b");
    expect(loadAllAssistants()).toHaveLength(1);
  });

  test("removeAssistantEntry clears activeAssistant when no entries remain", () => {
    writeLockfile({
      assistants: [makeEntry("only")],
      activeAssistant: "only",
    });
    removeAssistantEntry("only");
    expect(getActiveAssistant()).toBeNull();
    expect(loadAllAssistants()).toHaveLength(0);
  });

  test("removeAssistantEntry preserves activeAssistant when removing a different entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
      activeAssistant: "a",
    });
    removeAssistantEntry("b");
    expect(getActiveAssistant()).toBe("a");
    expect(loadAllAssistants()).toHaveLength(2);
  });

  test("loadLatestAssistant returns null when empty", () => {
    expect(loadLatestAssistant()).toBeNull();
  });

  test("loadLatestAssistant returns most recently hatched entry", () => {
    writeLockfile({
      assistants: [
        makeEntry("old", "http://localhost:7821", {
          hatchedAt: "2024-01-01T00:00:00Z",
        }),
        makeEntry("new", "http://localhost:7822", {
          hatchedAt: "2025-06-15T00:00:00Z",
        }),
        makeEntry("mid", "http://localhost:7823", {
          hatchedAt: "2024-06-15T00:00:00Z",
        }),
      ],
    });
    const latest = loadLatestAssistant();
    expect(latest).not.toBeNull();
    expect(latest!.assistantId).toBe("new");
  });

  test("loadLatestAssistant handles entries without hatchedAt", () => {
    writeLockfile({
      assistants: [
        makeEntry("no-date"),
        makeEntry("with-date", "http://localhost:7822", {
          hatchedAt: "2025-01-01T00:00:00Z",
        }),
      ],
    });
    const latest = loadLatestAssistant();
    expect(latest!.assistantId).toBe("with-date");
  });

  test("loadAllAssistants filters out entries missing required fields", () => {
    writeLockfile({
      assistants: [
        makeEntry("valid"),
        { cloud: "local" }, // missing assistantId and runtimeUrl
        { assistantId: "no-url", cloud: "local" }, // missing runtimeUrl
      ],
    });
    const all = loadAllAssistants();
    expect(all).toHaveLength(1);
    expect(all[0].assistantId).toBe("valid");
  });
});

describe("migrateLegacyEntry", () => {
  test("rewrites baseDataDir as resources.instanceDir", () => {
    /**
     * Tests that a legacy entry with top-level baseDataDir gets migrated
     * to the current resources.instanceDir format.
     */

    // GIVEN a legacy entry with baseDataDir set at the top level
    const entry: Record<string, unknown> = {
      assistantId: "my-assistant",
      runtimeUrl: "http://localhost:7830",
      cloud: "local",
      baseDataDir: "/home/user/.local/share/vellum/assistants/my-assistant",
    };

    // WHEN we migrate the entry
    const changed = migrateLegacyEntry(entry);

    // THEN the entry should be mutated
    expect(changed).toBe(true);

    // AND baseDataDir should be removed
    expect(entry.baseDataDir).toBeUndefined();

    // AND resources.instanceDir should contain the old baseDataDir value
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.instanceDir).toBe(
      "/home/user/.local/share/vellum/assistants/my-assistant",
    );
  });

  test("synthesises full resources when none exist", () => {
    /**
     * Tests that a legacy local entry with no resources object gets a
     * complete resources object synthesised with default ports and pidFile.
     */

    // GIVEN a local entry with no resources
    const entry: Record<string, unknown> = {
      assistantId: "old-assistant",
      runtimeUrl: "http://localhost:7830",
      cloud: "local",
    };

    // WHEN we migrate the entry
    const changed = migrateLegacyEntry(entry);

    // THEN the entry should be mutated
    expect(changed).toBe(true);

    // AND resources should be fully populated
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.instanceDir).toContain("old-assistant");
    expect(resources.daemonPort).toBe(7821);
    expect(resources.gatewayPort).toBe(7830);
    expect(resources.qdrantPort).toBe(6333);
    expect(resources.pidFile).toContain("vellum.pid");
  });

  test("infers gateway port from runtimeUrl", () => {
    /**
     * Tests that the gateway port is extracted from the runtimeUrl when
     * synthesising resources for a legacy entry.
     */

    // GIVEN a local entry with a non-default gateway port in the runtimeUrl
    const entry: Record<string, unknown> = {
      assistantId: "custom-port",
      runtimeUrl: "http://localhost:9999",
      cloud: "local",
    };

    // WHEN we migrate the entry
    migrateLegacyEntry(entry);

    // THEN the gateway port should match the runtimeUrl port
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.gatewayPort).toBe(9999);
  });

  test("skips non-local entries", () => {
    /**
     * Tests that remote (non-local) entries are left untouched.
     */

    // GIVEN a GCP entry without resources
    const entry: Record<string, unknown> = {
      assistantId: "gcp-assistant",
      runtimeUrl: "https://example.com",
      cloud: "gcp",
    };

    // WHEN we attempt to migrate it
    const changed = migrateLegacyEntry(entry);

    // THEN nothing should change
    expect(changed).toBe(false);
    expect(entry.resources).toBeUndefined();
  });

  test("backfills missing fields on partial resources", () => {
    /**
     * Tests that an entry with a partial resources object (e.g. only
     * instanceDir) gets the remaining fields backfilled.
     */

    // GIVEN an entry with partial resources (only instanceDir)
    const entry: Record<string, unknown> = {
      assistantId: "partial",
      runtimeUrl: "http://localhost:7830",
      cloud: "local",
      resources: {
        instanceDir: "/custom/path",
      },
    };

    // WHEN we migrate the entry
    const changed = migrateLegacyEntry(entry);

    // THEN the entry should be mutated
    expect(changed).toBe(true);

    // AND all missing resources fields should be filled in
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.instanceDir).toBe("/custom/path");
    expect(resources.daemonPort).toBe(7821);
    expect(resources.gatewayPort).toBe(7830);
    expect(resources.qdrantPort).toBe(6333);
    expect(resources.pidFile).toBe("/custom/path/.vellum/vellum.pid");
  });

  test("does not overwrite existing resources fields", () => {
    /**
     * Tests that an entry with a complete resources object is left untouched.
     */

    // GIVEN an entry with a complete resources object
    const entry: Record<string, unknown> = {
      assistantId: "complete",
      runtimeUrl: "http://localhost:7830",
      cloud: "local",
      resources: {
        instanceDir: "/my/path",
        daemonPort: 8000,
        gatewayPort: 8001,
        qdrantPort: 8002,
        pidFile: "/my/path/.vellum/vellum.pid",
      },
    };

    // WHEN we migrate the entry
    const changed = migrateLegacyEntry(entry);

    // THEN nothing should change
    expect(changed).toBe(false);

    // AND existing values should be preserved
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.daemonPort).toBe(8000);
    expect(resources.gatewayPort).toBe(8001);
    expect(resources.qdrantPort).toBe(8002);
  });

  test("baseDataDir does not overwrite existing resources.instanceDir", () => {
    /**
     * Tests that when both baseDataDir and resources.instanceDir exist,
     * the existing instanceDir is preserved and baseDataDir is removed.
     */

    // GIVEN an entry with both baseDataDir and resources.instanceDir
    const entry: Record<string, unknown> = {
      assistantId: "conflict",
      runtimeUrl: "http://localhost:7830",
      cloud: "local",
      baseDataDir: "/old/path",
      resources: {
        instanceDir: "/new/path",
        daemonPort: 7821,
        gatewayPort: 7830,
        qdrantPort: 6333,
        pidFile: "/new/path/.vellum/vellum.pid",
      },
    };

    // WHEN we migrate the entry
    const changed = migrateLegacyEntry(entry);

    // THEN baseDataDir should be removed
    expect(changed).toBe(true);
    expect(entry.baseDataDir).toBeUndefined();

    // AND the existing instanceDir should be preserved
    const resources = entry.resources as Record<string, unknown>;
    expect(resources.instanceDir).toBe("/new/path");
  });
});

describe("legacy migration via loadAllAssistants", () => {
  beforeEach(() => {
    try {
      rmSync(join(testDir, ".vellum.lock.json"));
    } catch {
      // file may not exist
    }
  });

  test("migrates legacy entries and persists to disk on read", () => {
    /**
     * Tests that reading assistants from a lockfile with legacy entries
     * triggers migration and persists the updated format to disk.
     */

    // GIVEN a lockfile with a legacy entry containing baseDataDir
    writeLockfile({
      assistants: [
        {
          assistantId: "legacy-bot",
          runtimeUrl: "http://localhost:7830",
          cloud: "local",
          baseDataDir: "/home/user/.local/share/vellum/assistants/legacy-bot",
        },
      ],
    });

    // WHEN we load assistants
    const all = loadAllAssistants();

    // THEN the entry should have resources populated
    expect(all).toHaveLength(1);
    expect(all[0].resources).toBeDefined();
    expect(all[0].resources!.instanceDir).toBe(
      "/home/user/.local/share/vellum/assistants/legacy-bot",
    );
    expect(all[0].resources!.gatewayPort).toBe(7830);

    // AND the lockfile on disk should reflect the migration
    const rawDisk = JSON.parse(
      readFileSync(join(testDir, ".vellum.lock.json"), "utf-8"),
    );
    const diskEntry = rawDisk.assistants[0];
    expect(diskEntry.baseDataDir).toBeUndefined();
    expect(diskEntry.resources.instanceDir).toBe(
      "/home/user/.local/share/vellum/assistants/legacy-bot",
    );
  });
});
