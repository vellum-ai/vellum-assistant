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

import { createHash } from "node:crypto";

import { devices } from "../commands/devices.js";
import { saveAssistantEntry } from "../lib/assistant-config.js";
import { computeDeviceId } from "../lib/guardian-token.js";

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
              clientReportedName: "Alice's Laptop",
              pairingUserAgent: "vellum-cli/1.2.3 (darwin)",
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
    // Reported name + user agent print verbatim when present.
    expect(logs).toContain("Alice's Laptop");
    expect(logs).toContain("vellum-cli/1.2.3 (darwin)");
    // Missing fields print plain-word placeholders, not a dash or "undefined".
    expect(logs).toContain("not reported");
    expect(logs).toContain("not recorded");
    expect(logs).not.toContain("undefined");

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("http://127.0.0.1:7833/v1/devices");
    expect(call.init?.method).toBe("GET");
    const keys = headerKeys(call.init);
    expect(keys).not.toContain("origin");
    expect(keys).not.toContain("x-forwarded-for");
  });

  // Matches currentHostHashedDeviceId in the command: sha256 of the same
  // stable device id the host's guardian lease registered with the gateway.
  function hostHash(): string {
    return createHash("sha256").update(computeDeviceId()).digest("hex");
  }

  test("labels this machine's own host credential in the human list", async () => {
    seedLocal("host-label", "http://127.0.0.1:7837");
    stubFetch((url) =>
      url.endsWith("/v1/devices")
        ? jsonResponse({
            devices: [
              {
                hashedDeviceId: hostHash(),
                platform: "cli",
                issuedAt: 1_700_000_000_000,
                expiresAt: null,
                lastUsedAt: null,
              },
              {
                hashedDeviceId: "hashBBB222",
                platform: "ios",
                issuedAt: 1_700_000_000_000,
                expiresAt: null,
                lastUsedAt: null,
              },
            ],
          })
        : jsonResponse({ error: "unexpected" }, 500),
    );

    process.argv = ["bun", "vellum", "devices", "host-label"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    const label = "this machine's host credential";
    expect(logs).toContain(label);
    // Only the host record carries the label.
    expect(logs.split(label)).toHaveLength(2);
    const hostIdx = logs.indexOf(hostHash());
    const otherIdx = logs.indexOf("hashBBB222");
    const labelIdx = logs.indexOf(label);
    expect(labelIdx).toBeGreaterThan(hostIdx);
    expect(labelIdx).toBeLessThan(otherIdx);
  });

  test("list --json marks only the host credential with isCurrentHost", async () => {
    seedLocal("host-json", "http://127.0.0.1:7838");
    const hostRecord = {
      hashedDeviceId: hostHash(),
      platform: "cli",
      issuedAt: 1_700_000_000_000,
      expiresAt: null,
      lastUsedAt: null,
    };
    const otherRecord = {
      hashedDeviceId: "hashBBB222",
      platform: "ios",
      issuedAt: 1_700_000_000_000,
      expiresAt: null,
      lastUsedAt: null,
    };
    stubFetch((url) =>
      url.endsWith("/v1/devices")
        ? jsonResponse({ devices: [hostRecord, otherRecord] })
        : jsonResponse({ error: "unexpected" }, 500),
    );

    process.argv = ["bun", "vellum", "devices", "host-json", "--json"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    const parsed = JSON.parse(logs) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(parsed.devices[0]).toEqual({ ...hostRecord, isCurrentHost: true });
    // Non-host records omit the field entirely (lean wire).
    expect(parsed.devices[1]).toEqual(otherRecord);
    expect("isCurrentHost" in parsed.devices[1]!).toBe(false);
  });

  test("revoking the host credential warns on stderr but proceeds", async () => {
    seedLocal("host-revoke", "http://127.0.0.1:7839");
    stubFetch((url) =>
      url.endsWith("/v1/devices/revoke")
        ? jsonResponse({ revoked: true })
        : jsonResponse({ error: "unexpected" }, 500),
    );

    process.argv = [
      "bun",
      "vellum",
      "devices",
      "revoke",
      hostHash(),
      "host-revoke",
      "--yes",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    expect(errors).toContain("own host credential");
    expect(logs).toContain(`Revoked device ${hostHash()}`);
    expect(fetchCalls).toHaveLength(1);
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

  test("list --json emits a single JSON document and no human text", async () => {
    seedLocal("json-host", "http://127.0.0.1:7835");
    const records = [
      {
        hashedDeviceId: "hashAAA111",
        platform: "cli",
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_800_000_000_000,
        lastUsedAt: null,
        clientReportedName: "Alice's Laptop",
        pairingUserAgent: "vellum-cli/1.2.3 (darwin)",
      },
    ];
    stubFetch((url) =>
      url.endsWith("/v1/devices")
        ? jsonResponse({ devices: records })
        : jsonResponse({ error: "unexpected" }, 500),
    );

    process.argv = ["bun", "vellum", "devices", "json-host", "--json"];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    expect(errors).toBe("");
    // Exactly one line on stdout, parseable, and zero prose.
    expect(logs).not.toContain("\n");
    // Round-trips clientReportedName/pairingUserAgent with no writer change.
    expect(JSON.parse(logs)).toEqual({ devices: records });
    expect(logs).not.toContain("Devices paired to");
  });

  test('list --json with zero devices emits {"devices":[]}', async () => {
    seedLocal("json-empty-host");
    stubFetch(() => jsonResponse({ devices: [] }));

    process.argv = ["bun", "vellum", "devices", "json-empty-host", "--json"];
    const { exited, logs } = await runDevices();

    expect(exited).toBe(false);
    expect(logs).toBe('{"devices":[]}');
  });

  test("revoke --json --yes emits one JSON line; identity preamble on stderr", async () => {
    seedLocal("json-revoke-host", "http://127.0.0.1:7836");
    stubFetch((url) =>
      url.endsWith("/v1/devices/revoke")
        ? jsonResponse({ revoked: true, hashedDeviceId: "hashAAA111" })
        : jsonResponse({ error: "unexpected" }, 500),
    );

    process.argv = [
      "bun",
      "vellum",
      "devices",
      "revoke",
      "hashAAA111",
      "json-revoke-host",
      "--yes",
      "--json",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(false);
    // Stdout is exactly one JSON document, no prose.
    expect(logs).not.toContain("\n");
    expect(JSON.parse(logs)).toEqual({
      ok: true,
      hashedDeviceId: "hashAAA111",
      assistantId: "json-revoke-host",
    });
    expect(logs).not.toContain("Device to revoke");
    // Destructive-identity preamble still printed, on stderr (cli/AGENTS.md).
    expect(errors).toContain("Device to revoke:");
    expect(errors).toContain("hashAAA111");
  });

  test("revoke --json without --yes exits 1 with empty stdout", async () => {
    seedLocal("json-noyes-host");

    process.argv = [
      "bun",
      "vellum",
      "devices",
      "revoke",
      "hashAAA111",
      "json-noyes-host",
      "--json",
    ];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(logs).toBe("");
    expect(errors).toContain("--json requires --yes");
    expect(fetchCalls).toHaveLength(0);
  });

  test("list --json still exits 1 with stderr on a non-2xx gateway response", async () => {
    seedLocal("json-err-host");
    stubFetch(() => jsonResponse({ error: { code: "FORBIDDEN" } }, 403));

    process.argv = ["bun", "vellum", "devices", "json-err-host", "--json"];
    const { exited, logs, errors } = await runDevices();

    expect(exited).toBe(true);
    expect(logs).toBe("");
    expect(errors).toContain("403");
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
