import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real assistant-config reads the lockfile from VELLUM_LOCKFILE_DIR.
const testDir = mkdtempSync(join(tmpdir(), "pair-command-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import { pair } from "../commands/pair.js";

// Distinct loopback (mint) vs reachable (advertised) URLs to verify the split.
const LOCAL_URL = "http://127.0.0.1:7830";
const RUNTIME_URL = "http://192.168.1.50:7830";

function writeLockfile(): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify({
      assistants: [
        {
          assistantId: "pair-test",
          runtimeUrl: RUNTIME_URL,
          localUrl: LOCAL_URL,
          cloud: "local",
        },
      ],
      activeAssistant: "pair-test",
    }),
  );
}

// Capture the real argv ONCE, before any test mutates it, and restore after
// every test — so a `['bun','vellum','pair',...]` argv can't leak into other
// test files in the same Bun run.
const ORIGINAL_ARGV = [...process.argv];

describe("pair command", () => {
  beforeEach(() => {
    writeLockfile();
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.VELLUM_LOCKFILE_DIR;
  });

  test("POSTs a cli device-bound pair request and prints a decodable bundle", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          token: "test-access-token",
          expiresAt: "2026-06-04T00:00:00.000Z",
          guardianId: "guardian-001",
          assistantId: "self",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "vellum", "pair", "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint over the loopback (localUrl), not the reachable runtime URL.
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${LOCAL_URL}/v1/pair`);
    expect(init.method).toBe("POST");
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    expect(headers["x-vellum-interface-id"]).toBe("cli");
    const body = JSON.parse(init.body as string);
    expect(typeof body.deviceId).toBe("string");
    expect(body.deviceId.length).toBeGreaterThan(0);
    expect(body.platform).toBe("cli");

    // The bundle advertises the REACHABLE runtime URL, not loopback.
    const out = JSON.parse(logs.join("\n"));
    expect(out.gatewayUrl).toBe(RUNTIME_URL);
    expect(out.assistantId).toBe("self");
    expect(out.token).toBe("test-access-token");
    expect(out.deviceId).toBe(body.deviceId);
  });

  test("resolves an unquoted multi-word display name", async () => {
    // Assistant whose display name has a space; passed as separate argv tokens.
    writeFileSync(
      join(testDir, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            name: "My Assistant",
            runtimeUrl: RUNTIME_URL,
            localUrl: LOCAL_URL,
            cloud: "local",
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({
          token: "t",
          expiresAt: "2026-06-04T00:00:00.000Z",
          guardianId: "g",
          assistantId: "self",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    process.argv = ["bun", "vellum", "pair", "My", "Assistant", "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Resolution succeeded (no exit), so the mint request was made.
    expect(fetchCalled).toBe(true);
  });

  test("refuses to advertise a loopback URL without --url (suggests the assistant's own port)", async () => {
    // Local hatch on a NON-default gateway port (e.g. a 2nd instance).
    const LOOPBACK_CUSTOM = "http://127.0.0.1:7842";
    writeFileSync(
      join(testDir, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            runtimeUrl: LOOPBACK_CUSTOM,
            localUrl: LOOPBACK_CUSTOM,
            cloud: "local",
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    process.argv = ["bun", "vellum", "pair"];
    let exited = false;
    try {
      await pair();
    } catch (e) {
      exited = (e as Error).message === "exit:1";
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // The suggested --url uses the assistant's actual port, not the default.
    expect(errors.join("\n")).toContain(":7842");
    expect(errors.join("\n")).not.toContain(":7830");

    // Exited with an error before minting — no token created for a dead URL.
    expect(exited).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("--url override allows pairing even when the runtime URL is loopback", async () => {
    writeFileSync(
      join(testDir, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            runtimeUrl: LOCAL_URL,
            localUrl: LOCAL_URL,
            cloud: "local",
          },
        ],
        activeAssistant: "pair-test",
      }),
    );

    const calls: Array<[string, RequestInit]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          token: "t",
          expiresAt: "2026-06-04T00:00:00.000Z",
          guardianId: "g",
          assistantId: "self",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    const OVERRIDE = "https://abc123.ngrok.app";
    process.argv = ["bun", "vellum", "pair", "--url", OVERRIDE, "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint still over loopback; bundle advertises the override.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${LOCAL_URL}/v1/pair`);
    const out = JSON.parse(logs.join("\n"));
    expect(out.gatewayUrl).toBe(OVERRIDE);
  });
});
