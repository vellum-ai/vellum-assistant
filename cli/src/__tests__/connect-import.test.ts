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
    deviceId: "dev-aaa",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(obj)).toString("base64");
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
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const entry = findAssistantByName("paired-dev-aaa");
    expect(entry).not.toBeNull();
    expect(entry!.runtimeUrl).toBe("http://10.0.0.5:7830");
    expect(entry!.cloud).toBe("paired");
    expect(loadGuardianToken("paired-dev-aaa")?.accessToken).toBe("test-token");
    // Back-compat: a bundle without refresh fields imports access-only.
    expect(loadGuardianToken("paired-dev-aaa")?.refreshToken).toBe("");
  });

  test("persists the refresh credential when the bundle carries one", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({
        deviceId: "dev-refresh",
        token: "acc-tok",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
        refreshAfter: "2026-07-01T00:00:00.000Z",
      }),
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    const tok = loadGuardianToken("paired-dev-refresh");
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
        deviceId: "dev-num",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: expiresMs,
      }),
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    expect(loadGuardianToken("paired-dev-num")?.refreshTokenExpiresAt).toBe(
      expiresMs,
    );
  });

  test("two different bundles (both assistantId 'self') do not collide", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ deviceId: "dev-one", token: "tok1" }),
    ];
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectImport();
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ deviceId: "dev-two", token: "tok2" }),
      ];
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }

    expect(findAssistantByName("paired-dev-one")).not.toBeNull();
    expect(findAssistantByName("paired-dev-two")).not.toBeNull();
    expect(loadGuardianToken("paired-dev-one")?.accessToken).toBe("tok1");
    expect(loadGuardianToken("paired-dev-two")?.accessToken).toBe("tok2");
  });

  test("--name registers the entry under that name", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ deviceId: "dev-named" }),
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

  test("sanitizes a malicious bundle deviceId (no path traversal in the local id)", async () => {
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

    // The registered id must contain no path separators or `..`.
    const m = logs.join("\n").match(/paired assistant '([^']+)'/);
    expect(m).not.toBeNull();
    const id = m![1];
    expect(id).not.toContain("/");
    expect(id).not.toContain("..");
    expect(loadGuardianToken(id)?.accessToken).toBe("tokX");
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
      bundleFor({ deviceId: "dx" }),
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

  test("re-importing the same pairing updates in place", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ deviceId: "dev-re", token: "t1" }),
      ];
      await connectImport();
      process.argv = [
        "bun",
        "vellum",
        "connect",
        "import",
        bundleFor({ deviceId: "dev-re", token: "t2" }),
      ];
      await connectImport();
    } finally {
      logSpy.mockRestore();
    }
    expect(loadGuardianToken("paired-dev-re")?.accessToken).toBe("t2");
  });

  test("rejects a bundle whose gatewayUrl is not http(s)", async () => {
    process.argv = [
      "bun",
      "vellum",
      "connect",
      "import",
      bundleFor({ gatewayUrl: "ftp://nope", deviceId: "dz" }),
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
    expect(findAssistantByName("paired-dz")).toBeNull();
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
    // A malformed bundle has no deviceId, so no `paired-*` entry is created.
    expect(findAssistantByName("paired-")).toBeNull();
  });
});
