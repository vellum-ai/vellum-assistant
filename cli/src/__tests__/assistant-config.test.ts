import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
