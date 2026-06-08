/**
 * Tests for `vellum devices` (list) and `vellum devices revoke <hashedDeviceId>`:
 * the host-side CLI that calls the loopback `GET /v1/devices` and
 * `POST /v1/devices/revoke` endpoints. Verifies host-gating (refuses paired
 * connections), the destructive-revoke confirmation, and that requests carry no
 * browser/proxy headers.
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

const testDir = mkdtempSync(join(tmpdir(), "devices-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_FETCH = globalThis.fetch;

import { devices } from "../commands/devices.js";
import { saveAssistantEntry } from "../lib/assistant-config.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];

/** Stub global fetch (spyOn does not intercept fetch in Bun). */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RunResult {
  exited: boolean;
  logs: string;
  errors: string;
}

/** Run devices() with console + process.exit spied. */
async function runDevices(): Promise<RunResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit:${c}`);
  }) as never);
  let exited = false;
  try {
    await devices();
  } catch (e) {
    exited = (e as Error).message?.startsWith("exit:") ?? false;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, logs: logs.join("\n"), errors: errors.join("\n") };
}

function headerKeys(init?: RequestInit): string[] {
  const h = init?.headers as Record<string, string> | undefined;
  return h ? Object.keys(h).map((k) => k.toLowerCase()) : [];
}

describe("vellum devices", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_CONFIG_HOME = testDir;
    fetchCalls = [];
    // Default stub: any unexpected call is recorded and 500s.
    stubFetch(() => jsonResponse({ error: "unexpected" }, 500));
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function seedLocal(id: string, localUrl = "http://127.0.0.1:7830"): void {
    saveAssistantEntry({
      assistantId: id,
      name: id,
      runtimeUrl: "http://127.0.0.1:7830",
      localUrl,
      cloud: "local",
      species: "vellum",
    });
  }

  test("--help prints usage including Examples", async () => {
    process.argv = ["bun", "vellum", "devices", "--help"];
    const { logs } = await runDevices();
    expect(logs).toContain("USAGE:");
    expect(logs).toContain("EXAMPLES:");
    expect(logs).toContain("vellum devices revoke");
  });

  test("lists active devices over loopback with no browser/proxy headers", async () => {
    seedLocal("list-host", "http://127.0.0.1:7833");
    stubFetch((url) => {
      if (url.endsWith("/v1/devices")) {
        return jsonResponse({
          devices: [
            {
              hashedDeviceId: "hashAAA111",
              platform: "cli",
              issuedAt: 1_700_000_000_000,
              expiresAt: 1_800_000_000_000,
              lastUsedAt: 1_750_000_000_000,
            },
            {
              hashedDeviceId: "hashBBB222",
              platform: "webview",
              issuedAt: 1_700_000_000_000,
              expiresAt: null,
              lastUsedAt: null,
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    process.argv = ["bun", "vellum", "devices", "list-host"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    // Both full hashes + platforms surfaced; null lastUsedAt → "never".
    expect(logs).toContain("hashAAA111");
    expect(logs).toContain("hashBBB222");
    expect(logs).toContain("cli");
    expect(logs).toContain("webview");
    expect(logs).toContain("never");

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("http://127.0.0.1:7833/v1/devices");
    expect(call.init?.method).toBe("GET");
    const keys = headerKeys(call.init);
    expect(keys).not.toContain("origin");
    expect(keys).not.toContain("x-forwarded-for");
  });

  test("prints a clear message when no devices are paired", async () => {
    seedLocal("empty-host");
    stubFetch(() => jsonResponse({ devices: [] }));

    process.argv = ["bun", "vellum", "devices", "empty-host"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toContain("No devices are paired to empty-host");
  });

  test("revoke posts the hashedDeviceId with --yes (no prompt)", async () => {
    seedLocal("revoke-host", "http://127.0.0.1:7834");
    stubFetch((url) => {
      if (url.endsWith("/v1/devices/revoke")) {
        return jsonResponse({ revoked: true, hashedDeviceId: "hashAAA111" });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    process.argv = [
      "bun",
      "vellum",
      "devices",
      "revoke",
      "hashAAA111",
      "revoke-host",
      "--yes",
    ];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toContain("Revoked device hashAAA111");

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("http://127.0.0.1:7834/v1/devices/revoke");
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      hashedDeviceId: "hashAAA111",
    });
  });

  test("revoke without a hashedDeviceId errors and makes no request", async () => {
    process.argv = ["bun", "vellum", "devices", "revoke", "--yes"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("hashedDeviceId is required");
    expect(fetchCalls).toHaveLength(0);
  });

  test("revoke refuses without --yes in a non-interactive terminal", async () => {
    seedLocal("rh3");
    // process.stdin.isTTY is falsy under the test runner → not promptable.
    process.argv = ["bun", "vellum", "devices", "revoke", "hashZZZ", "rh3"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("--yes");
    expect(fetchCalls).toHaveLength(0);
  });

  test("host-gates a paired connection (points to the host / unpair)", async () => {
    saveAssistantEntry({
      assistantId: "paired-box",
      name: "Paired Box",
      runtimeUrl: "http://10.0.0.9:7830",
      cloud: "paired",
      paired: true,
      species: "vellum",
    });

    process.argv = ["bun", "vellum", "devices", "paired-box"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("vellum unpair");
    expect(fetchCalls).toHaveLength(0);
  });

  test("surfaces a non-2xx gateway response on list", async () => {
    seedLocal("err-host");
    stubFetch(() => jsonResponse({ error: { code: "FORBIDDEN" } }, 403));

    process.argv = ["bun", "vellum", "devices", "err-host"];
    const { exited, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(errors).toContain("403");
  });
});
