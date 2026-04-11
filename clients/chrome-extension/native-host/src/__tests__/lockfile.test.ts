/**
 * Unit tests for the lockfile reader (`src/lockfile.ts`).
 *
 * These tests exercise:
 *   - Fallback from `.vellum.lock.json` to `.vellum.lockfile.json`
 *   - Parsing of assistant entries with and without `resources.daemonPort`
 *   - Active-assistant resolution
 *   - Graceful handling of missing, empty, and malformed lockfiles
 *   - The `resolveDaemonPort` convenience helper
 *
 * Each test creates a temporary directory via `mkdtemp`, sets
 * `VELLUM_LOCKFILE_DIR` to point at it, and cleans up after itself.
 * This avoids touching the user's real `~/.vellum.lock.json`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  readAssistantInventory,
  resolveDaemonPort,
  type AssistantSummary,
} from "../lockfile.js";

// ---------------------------------------------------------------------------
// Test scaffold — temp directory & env override
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lockfile-test-"));
  process.env.VELLUM_LOCKFILE_DIR = tempDir;
});

afterEach(() => {
  delete process.env.VELLUM_LOCKFILE_DIR;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

/** Write a lockfile to the temp directory under the given filename. */
function writeLockfile(
  filename: string,
  data: Record<string, unknown>,
): void {
  writeFileSync(join(tempDir, filename), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lockfile — readAssistantInventory", () => {
  test("returns empty inventory when no lockfile exists", () => {
    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistantId).toBeNull();
  });

  test("reads from .vellum.lock.json (primary)", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "alpha",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 7821 },
        },
      ],
      activeAssistant: "alpha",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("alpha");
    expect(result.assistants[0]!.daemonPort).toBe(7821);
    expect(result.assistants[0]!.isActive).toBe(true);
    expect(result.activeAssistantId).toBe("alpha");
  });

  test("falls back to .vellum.lockfile.json when primary is missing", () => {
    writeLockfile(".vellum.lockfile.json", {
      assistants: [
        {
          assistantId: "beta",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
          resources: { daemonPort: 7822 },
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("beta");
    expect(result.assistants[0]!.daemonPort).toBe(7822);
  });

  test("prefers .vellum.lock.json over .vellum.lockfile.json when both exist", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "primary",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });
    writeLockfile(".vellum.lockfile.json", {
      assistants: [
        {
          assistantId: "legacy",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("primary");
  });

  test("filters entries missing required fields", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        // Valid entry
        {
          assistantId: "good",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
        // Missing runtimeUrl
        { assistantId: "no-url", cloud: "local" },
        // Missing assistantId
        { cloud: "local", runtimeUrl: "http://localhost:7832" },
        // Missing cloud
        { assistantId: "no-cloud", runtimeUrl: "http://localhost:7833" },
        // Not an object
        "just-a-string",
        null,
        42,
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("good");
  });

  test("returns daemonPort as undefined when resources block is absent", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "cloud-only",
          cloud: "gcp",
          runtimeUrl: "https://example.com:443",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants[0]!.daemonPort).toBeUndefined();
  });

  test("returns daemonPort as undefined when resources.daemonPort is not a number", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "bad-port",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: "not-a-number" },
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants[0]!.daemonPort).toBeUndefined();
  });

  test("returns daemonPort as undefined when port is out of range", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "high-port",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 70000 },
        },
        {
          assistantId: "zero-port",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
          resources: { daemonPort: 0 },
        },
        {
          assistantId: "negative-port",
          cloud: "local",
          runtimeUrl: "http://localhost:7832",
          resources: { daemonPort: -1 },
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants[0]!.daemonPort).toBeUndefined();
    expect(result.assistants[1]!.daemonPort).toBeUndefined();
    expect(result.assistants[2]!.daemonPort).toBeUndefined();
  });

  test("marks only the active assistant with isActive=true", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "one",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
        {
          assistantId: "two",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
        },
        {
          assistantId: "three",
          cloud: "local",
          runtimeUrl: "http://localhost:7832",
        },
      ],
      activeAssistant: "two",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(3);
    expect(result.assistants[0]!.isActive).toBe(false);
    expect(result.assistants[1]!.isActive).toBe(true);
    expect(result.assistants[2]!.isActive).toBe(false);
    expect(result.activeAssistantId).toBe("two");
  });

  test("handles lockfile with no assistants array", () => {
    writeLockfile(".vellum.lock.json", {
      platformBaseUrl: "https://platform.example.com",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistantId).toBeNull();
  });

  test("handles lockfile with assistants as non-array", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: "not-an-array",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
  });

  test("handles malformed JSON gracefully", () => {
    writeFileSync(
      join(tempDir, ".vellum.lock.json"),
      "{ this is not valid JSON }",
    );

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistantId).toBeNull();
  });

  test("handles lockfile that is an array (not an object)", () => {
    writeFileSync(
      join(tempDir, ".vellum.lock.json"),
      JSON.stringify([1, 2, 3]),
    );

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistantId).toBeNull();
  });

  test("multi-assistant inventory with mixed cloud types and resources", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "local-one",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: {
            daemonPort: 7821,
            gatewayPort: 7830,
            instanceDir: "/home/user",
          },
        },
        {
          assistantId: "local-two",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
          resources: {
            daemonPort: 7823,
            gatewayPort: 7831,
          },
        },
        {
          assistantId: "cloud-one",
          cloud: "vellum",
          runtimeUrl: "https://cloud.example.com",
        },
      ],
      activeAssistant: "local-one",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(3);

    const [localOne, localTwo, cloudOne] = result.assistants as [
      AssistantSummary,
      AssistantSummary,
      AssistantSummary,
    ];

    expect(localOne.assistantId).toBe("local-one");
    expect(localOne.cloud).toBe("local");
    expect(localOne.runtimeUrl).toBe("http://localhost:7830");
    expect(localOne.daemonPort).toBe(7821);
    expect(localOne.isActive).toBe(true);

    expect(localTwo.assistantId).toBe("local-two");
    expect(localTwo.daemonPort).toBe(7823);
    expect(localTwo.isActive).toBe(false);

    expect(cloudOne.assistantId).toBe("cloud-one");
    expect(cloudOne.cloud).toBe("vellum");
    expect(cloudOne.daemonPort).toBeUndefined();
    expect(cloudOne.isActive).toBe(false);
  });
});

describe("lockfile — resolveDaemonPort", () => {
  test("returns the daemon port for a known assistant", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "target",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 9999 },
        },
      ],
    });

    expect(resolveDaemonPort("target")).toBe(9999);
  });

  test("returns undefined for an unknown assistant", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "other",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 7821 },
        },
      ],
    });

    expect(resolveDaemonPort("nonexistent")).toBeUndefined();
  });

  test("returns undefined when assistant has no daemon port", () => {
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "cloud",
          cloud: "vellum",
          runtimeUrl: "https://cloud.example.com",
        },
      ],
    });

    expect(resolveDaemonPort("cloud")).toBeUndefined();
  });

  test("returns undefined when lockfile is missing", () => {
    expect(resolveDaemonPort("anything")).toBeUndefined();
  });
});
