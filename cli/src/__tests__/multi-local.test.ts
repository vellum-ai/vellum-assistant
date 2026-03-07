import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create a temp directory that acts as a fake home, so allocateLocalResources()
// never touches the real ~/.vellum directory.
const testDir = mkdtempSync(join(tmpdir(), "cli-multi-local-test-"));
process.env.BASE_DATA_DIR = testDir;

// Mock homedir() to return testDir — this isolates allocateLocalResources()
// which uses homedir() directly for instance directory creation.
const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => testDir,
}));
// Also mock the bare "os" specifier since assistant-config.ts uses `from "os"`
mock.module("os", () => ({
  ...realOs,
  homedir: () => testDir,
}));

// Mock probePort so we control which ports appear in-use without touching the network
const probePortMock = mock<(port: number, host?: string) => Promise<boolean>>(
  () => Promise.resolve(false),
);
mock.module("../lib/port-probe.js", () => ({
  probePort: probePortMock,
}));

import {
  allocateLocalResources,
  resolveTargetAssistant,
  setActiveAssistant,
  getActiveAssistant,
  removeAssistantEntry,
  saveAssistantEntry,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "../lib/constants.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.BASE_DATA_DIR;
});

function writeLockfile(data: unknown): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(data, null, 2),
  );
}

function readLockfileRaw(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(testDir, ".vellum.lock.json"), "utf-8"),
  ) as Record<string, unknown>;
}

const makeEntry = (
  id: string,
  cloud = "local",
  extra?: Partial<AssistantEntry>,
): AssistantEntry => ({
  assistantId: id,
  runtimeUrl: `http://localhost:${DEFAULT_DAEMON_PORT}`,
  cloud,
  ...extra,
});

function resetLockfile(): void {
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
}

describe("multi-local", () => {
  beforeEach(() => {
    resetLockfile();
    probePortMock.mockReset();
    probePortMock.mockImplementation(() => Promise.resolve(false));
  });

  describe("allocateLocalResources() produces non-conflicting ports", () => {
    test("first instance returns default legacy resources", async () => {
      // GIVEN no local assistants exist in the lockfile

      // WHEN we allocate resources for the first instance
      const res = await allocateLocalResources("instance-a");

      // THEN it returns the default legacy layout (home dir, default ports)
      expect(res.instanceDir).toBe(testDir);
      expect(res.daemonPort).toBe(DEFAULT_DAEMON_PORT);
      expect(res.gatewayPort).toBe(DEFAULT_GATEWAY_PORT);
      expect(res.qdrantPort).toBe(DEFAULT_QDRANT_PORT);
    });

    test("second instance gets distinct ports and dir when first instance is saved", async () => {
      // GIVEN a first local assistant already exists in the lockfile
      saveAssistantEntry(makeEntry("instance-a"));

      // AND the default ports are occupied
      const occupiedPorts = new Set([
        DEFAULT_DAEMON_PORT,
        DEFAULT_GATEWAY_PORT,
        DEFAULT_QDRANT_PORT,
      ]);
      probePortMock.mockImplementation((port: number) =>
        Promise.resolve(occupiedPorts.has(port)),
      );

      // WHEN we allocate resources for a second instance
      const b = await allocateLocalResources("instance-b");

      // THEN the second instance gets non-default ports
      expect(occupiedPorts.has(b.daemonPort)).toBe(false);
      expect(occupiedPorts.has(b.gatewayPort)).toBe(false);
      expect(occupiedPorts.has(b.qdrantPort)).toBe(false);

      // AND it gets its own dedicated instance directory
      expect(b.instanceDir).toContain("instance-b");
    });

    test("skips ports that probePort reports as in-use", async () => {
      // GIVEN a first local assistant already exists in the lockfile
      saveAssistantEntry(makeEntry("existing"));

      // AND the default daemon ports are occupied
      const portsInUse = new Set([
        DEFAULT_DAEMON_PORT,
        DEFAULT_DAEMON_PORT + 1,
      ]);
      probePortMock.mockImplementation((port: number) =>
        Promise.resolve(portsInUse.has(port)),
      );

      // WHEN we allocate resources for a new instance
      const res = await allocateLocalResources("probe-test");

      // THEN the daemon port skips all occupied ports
      expect(res.daemonPort).toBeGreaterThan(DEFAULT_DAEMON_PORT + 1);
      expect(portsInUse.has(res.daemonPort)).toBe(false);
    });
  });

  describe("resolveTargetAssistant() priority chain", () => {
    test("explicit name returns that entry", () => {
      writeLockfile({
        assistants: [makeEntry("alpha"), makeEntry("beta")],
      });
      const result = resolveTargetAssistant("beta");
      expect(result.assistantId).toBe("beta");
    });

    test("active assistant set returns the active entry", () => {
      writeLockfile({
        assistants: [makeEntry("alpha"), makeEntry("beta")],
        activeAssistant: "alpha",
      });
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("alpha");
    });

    test("sole local assistant returns it", () => {
      writeLockfile({
        assistants: [makeEntry("only-one")],
      });
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("only-one");
    });

    test("multiple local assistants and no active throws with guidance", () => {
      writeLockfile({
        assistants: [makeEntry("x"), makeEntry("y")],
      });
      // resolveTargetAssistant calls process.exit(1) on ambiguity
      const mockExit = mock(() => {
        throw new Error("process.exit called");
      });
      const origExit = process.exit;
      process.exit = mockExit as unknown as typeof process.exit;
      try {
        expect(() => resolveTargetAssistant()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      } finally {
        process.exit = origExit;
      }
    });

    test("no local assistants throws", () => {
      writeLockfile({ assistants: [] });
      const mockExit = mock(() => {
        throw new Error("process.exit called");
      });
      const origExit = process.exit;
      process.exit = mockExit as unknown as typeof process.exit;
      try {
        expect(() => resolveTargetAssistant()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      } finally {
        process.exit = origExit;
      }
    });
  });

  describe("setActiveAssistant() / getActiveAssistant() round-trip", () => {
    test("set active, read it back", () => {
      writeLockfile({ assistants: [makeEntry("my-assistant")] });
      setActiveAssistant("my-assistant");
      expect(getActiveAssistant()).toBe("my-assistant");
    });

    test("lockfile is updated on disk", () => {
      writeLockfile({ assistants: [makeEntry("disk-check")] });
      setActiveAssistant("disk-check");
      const raw = readLockfileRaw();
      expect(raw.activeAssistant).toBe("disk-check");
    });
  });

  describe("removeAssistantEntry() clears matching activeAssistant", () => {
    test("set active to foo, remove foo, verify active is null", () => {
      writeLockfile({
        assistants: [makeEntry("foo"), makeEntry("bar")],
        activeAssistant: "foo",
      });
      removeAssistantEntry("foo");
      expect(getActiveAssistant()).toBeNull();
    });

    test("set active to foo, remove bar, verify active is still foo", () => {
      writeLockfile({
        assistants: [makeEntry("foo"), makeEntry("bar")],
        activeAssistant: "foo",
      });
      removeAssistantEntry("bar");
      expect(getActiveAssistant()).toBe("foo");
    });
  });

  describe("remote non-regression", () => {
    test("resolveTargetAssistant works with remote entries", () => {
      writeLockfile({
        assistants: [
          makeEntry("my-remote", "gcp", {
            runtimeUrl: "http://10.0.0.1:7821",
          }),
        ],
        activeAssistant: "my-remote",
      });
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("my-remote");
      expect(result.cloud).toBe("gcp");
    });

    test("remote entries don't get resources applied", () => {
      const remoteEntry = makeEntry("cloud-box", "aws", {
        runtimeUrl: "http://10.0.0.2:7821",
      });
      writeLockfile({ assistants: [remoteEntry] });
      // Save and reload to verify resources are not injected
      saveAssistantEntry(remoteEntry);
      const result = resolveTargetAssistant("cloud-box");
      expect(result.resources).toBeUndefined();
    });
  });
});
