/**
 * Unit tests for the lockfile reader (`src/lockfile.ts`).
 *
 * These tests exercise:
 *   - Fallback from `.vellum.lock.json` to `.vellum.lockfile.json`
 *   - Env-aware path resolution (`VELLUM_ENVIRONMENT` production vs non-prod)
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
let savedVellumEnvironment: string | undefined;
let savedXdgConfigHome: string | undefined;
let savedVellumLockfileDir: string | undefined;

beforeEach(() => {
  // Save env vars we may mutate so each test starts from a clean slate.
  savedVellumEnvironment = process.env.VELLUM_ENVIRONMENT;
  savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  savedVellumLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
  delete process.env.VELLUM_ENVIRONMENT;
  delete process.env.XDG_CONFIG_HOME;

  tempDir = mkdtempSync(join(tmpdir(), "lockfile-test-"));
  process.env.VELLUM_LOCKFILE_DIR = tempDir;
});

afterEach(() => {
  // Restore each variable to its original value (including "was unset").
  if (savedVellumEnvironment === undefined) {
    delete process.env.VELLUM_ENVIRONMENT;
  } else {
    process.env.VELLUM_ENVIRONMENT = savedVellumEnvironment;
  }
  if (savedXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  }
  if (savedVellumLockfileDir === undefined) {
    delete process.env.VELLUM_LOCKFILE_DIR;
  } else {
    process.env.VELLUM_LOCKFILE_DIR = savedVellumLockfileDir;
  }

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

describe("lockfile — env-aware path resolution", () => {
  test("non-prod env reads lockfile.json from VELLUM_LOCKFILE_DIR", () => {
    // With VELLUM_LOCKFILE_DIR set (by beforeEach) to `tempDir` and
    // VELLUM_ENVIRONMENT=dev, the reader should look for
    // `${tempDir}/lockfile.json` (NOT `.vellum.lock.json`).
    process.env.VELLUM_ENVIRONMENT = "dev";
    writeLockfile("lockfile.json", {
      assistants: [
        {
          assistantId: "dev-one",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 7821 },
        },
      ],
      activeAssistant: "dev-one",
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("dev-one");
    expect(result.assistants[0]!.daemonPort).toBe(7821);
    expect(result.activeAssistantId).toBe("dev-one");
  });

  test("non-prod env ignores .vellum.lock.json (wrong filename for non-prod)", () => {
    process.env.VELLUM_ENVIRONMENT = "staging";
    // A prod-shaped file at the override dir should NOT be picked up when
    // running in a non-prod env; only `lockfile.json` is the canonical
    // non-prod name.
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "should-not-be-found",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
    expect(result.activeAssistantId).toBeNull();
  });

  test("non-prod env without VELLUM_LOCKFILE_DIR reads from $XDG_CONFIG_HOME/vellum-<env>", () => {
    // Remove the override so the reader falls back to the XDG path.
    delete process.env.VELLUM_LOCKFILE_DIR;
    process.env.VELLUM_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = tempDir;

    const envDir = join(tempDir, "vellum-dev");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(envDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "xdg-dev",
            cloud: "local",
            runtimeUrl: "http://localhost:7830",
            resources: { daemonPort: 7821 },
          },
        ],
        activeAssistant: "xdg-dev",
      }),
    );

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("xdg-dev");
    expect(result.assistants[0]!.daemonPort).toBe(7821);
  });

  test("non-prod env iterates exactly one candidate (no legacy fallback)", () => {
    // `.vellum.lockfile.json` is the prod-legacy name and should NOT be
    // read in non-prod mode.
    process.env.VELLUM_ENVIRONMENT = "local";
    writeLockfile(".vellum.lockfile.json", {
      assistants: [
        {
          assistantId: "legacy-should-not-load",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toEqual([]);
  });

  test("unknown env name falls back to production path (reads .vellum.lock.json)", () => {
    // `foo` is not in NON_PRODUCTION_ENVIRONMENTS; should behave like prod.
    process.env.VELLUM_ENVIRONMENT = "foo";
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "fallback-prod",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 7821 },
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("fallback-prod");
    expect(result.assistants[0]!.daemonPort).toBe(7821);
  });

  test("empty VELLUM_ENVIRONMENT is treated as production", () => {
    process.env.VELLUM_ENVIRONMENT = "";
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "empty-env",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("empty-env");
  });

  test("whitespace-only VELLUM_ENVIRONMENT is treated as production", () => {
    process.env.VELLUM_ENVIRONMENT = "   ";
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "whitespace-env",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("whitespace-env");
  });

  test("explicit VELLUM_ENVIRONMENT=production uses production path", () => {
    process.env.VELLUM_ENVIRONMENT = "production";
    writeLockfile(".vellum.lock.json", {
      assistants: [
        {
          assistantId: "explicit-prod",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
        },
      ],
    });

    const result = readAssistantInventory();
    expect(result.assistants).toHaveLength(1);
    expect(result.assistants[0]!.assistantId).toBe("explicit-prod");
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
