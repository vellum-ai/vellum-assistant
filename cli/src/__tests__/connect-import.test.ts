/**
 * Tests for `vellum connect import <blob>`: decode a `vellum pair` bundle and
 * persist a lockfile entry + guardian token under a unique local id.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "connect-import-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];

import { connectImport } from "../commands/connect/import.js";
import {
  findAssistantByName,
  saveAssistantEntry,
} from "../lib/assistant-config.js";
import { loadGuardianToken } from "../lib/guardian-token.js";

function bundleFor(overrides: Record<string, unknown> = {}): string {
  const obj = {
    gatewayUrl: "http://10.0.0.5:7830",
    assistantId: "self",
    token: "test-token",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function importedIdsFromLogs(logs: string[]): string[] {
  return [...logs.join("\n").matchAll(/paired assistant '([^']+)'/g)].map(
    (m) => m[1],
  );
}

describe("connect import", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_CONFIG_HOME = testDir;
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("writes a lockfile entry + guardian token from a valid bundle", async () => {
    process.argv = ["bun", "vellum", "connect", "import", bundleFor()];
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const [localId] = importedIdsFromLogs(logs);
    expect(localId).toBeDefined();
    const id = localId!;
    expect(id).toMatch(/^paired-/);
    const entry = findAssistantByName(id);
    expect(entry).not.toBeNull();
    expect(entry!.runtimeUrl).toBe("http://10.0.0.5:7830");
    expect(entry!.cloud).toBe("paired");
    expect(loadGuardianToken(id)?.accessToken).toBe("test-token");
    // Back-compat: a bundle without refresh fields imports access-only.
    expect(loadGuardianToken(id)?.refreshToken).toBe("");
  });

  test("persists the refresh credential when the bundle carries one", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({
        token: "acc-tok",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
        refreshAfter: "2026-07-01T00:00:00.000Z",
      }),
      "--name",
      "refresh-box",
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const tok = loadGuardianToken("refresh-box");
    expect(tok?.accessToken).toBe("acc-tok");
    expect(tok?.refreshToken).toBe("refresh-tok");
    expect(tok?.refreshTokenExpiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(tok?.refreshAfter).toBe("2026-07-01T00:00:00.000Z");
  });

  test("preserves a numeric (epoch-ms) refreshTokenExpiresAt", async () => {
    // GuardianTokenData allows refreshTokenExpiresAt to be an epoch-ms number;
    // a numeric value in the bundle must round-trip, not be dropped to 0.
    const expiresMs = 1893456000000; // 2030-01-01
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: expiresMs,
      }),
      "--name",
      "num-box",
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    expect(loadGuardianToken("num-box")?.refreshTokenExpiresAt).toBe(expiresMs);
  });

  test("two different bundles (both assistantId 'self') do not collide", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ token: "tok1" }),
    ];
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );
    try {
      await connectImport();
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ token: "tok2" }),
      ];
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const ids = importedIdsFromLogs(logs);
    expect(ids).toHaveLength(2);
    const firstId = ids[0]!;
    const secondId = ids[1]!;
    expect(firstId).not.toBe(secondId);
    expect(findAssistantByName(firstId)).not.toBeNull();
    expect(findAssistantByName(secondId)).not.toBeNull();
    expect(loadGuardianToken(firstId)?.accessToken).toBe("tok1");
    expect(loadGuardianToken(secondId)?.accessToken).toBe("tok2");
  });

  test("--name registers the entry under that name", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor(),
      "--name",
      "Desk Box",
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }
    // Slugified to a stable id.
    expect(findAssistantByName("desk-box")).not.toBeNull();
  });

  test("ignores a legacy bundle deviceId when choosing the generated local id", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ deviceId: "-/../../tmp/x", token: "tokX" }),
    ];
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const [id] = importedIdsFromLogs(logs);
    expect(id).toBeDefined();
    const localId = id!;
    expect(localId).toMatch(/^paired-/);
    expect(localId).not.toContain("/");
    expect(localId).not.toContain("..");
    expect(loadGuardianToken(localId)?.accessToken).toBe("tokX");
  });

  test("does not overwrite an existing non-paired assistant", async () => {
    saveAssistantEntry({
      assistantId: "desk",
      name: "Desk",
      runtimeUrl: "http://127.0.0.1:7830",
      cloud: "local",
      species: "vellum",
    });
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor(),
      "--name",
      "desk",
    ];
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`);
    }) as never);
    let exited = false;
    try {
      await connectImport();
    } catch (e) {
      exited = (e as Error).message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exited).toBe(true);
    // The original local assistant is untouched (not overwritten).
    const e = findAssistantByName("desk");
    expect(e!.runtimeUrl).toBe("http://127.0.0.1:7830");
    expect(e!.paired).toBeUndefined();
  });

  test("re-importing with the same --name updates in place", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ token: "t1" }),
        "--name",
        "remote-desk",
      ];
      await connectImport();
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ token: "t2" }),
        "--name",
        "remote-desk",
      ];
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }
    expect(loadGuardianToken("remote-desk")?.accessToken).toBe("t2");
  });

  test("rejects a bundle whose gatewayUrl is not http(s)", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ gatewayUrl: "ftp://nope" }),
      "--name",
      "bad-url",
    ];
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`);
    }) as never);
    let exited = false;
    try {
      await connectImport();
    } catch (e) {
      exited = (e as Error).message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exited).toBe(true);
    expect(findAssistantByName("bad-url")).toBeNull();
  });

  test("a malformed bundle exits 1 and registers nothing", async () => {
    process.argv = ["bun", "vellum", "connect", "import", "not-valid-base64!!"];
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`);
    }) as never);
    let exited = false;
    try {
      await connectImport();
    } catch (e) {
      exited = (e as Error).message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exited).toBe(true);
    // A malformed bundle has no generated id, so no `paired-*` entry is created.
    expect(findAssistantByName("paired-")).toBeNull();
  });
});
