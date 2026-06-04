import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real assistant-config reads the lockfile from VELLUM_LOCKFILE_DIR.
const testDir = mkdtempSync(join(tmpdir(), "pair-command-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import { pair } from "../commands/pair.js";

const GATEWAY_URL = "http://127.0.0.1:7830";

function writeLockfile(): void {
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify({
      assistants: [
        {
          assistantId: "pair-test",
          runtimeUrl: GATEWAY_URL,
          localUrl: GATEWAY_URL,
          cloud: "local",
        },
      ],
      activeAssistant: "pair-test",
    }),
  );
}

describe("pair command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
    writeLockfile();
  });

  afterAll(() => {
    process.argv = originalArgv;
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

    // Hit /v1/pair with the cli interface + a device-bound body.
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`${GATEWAY_URL}/v1/pair`);
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

    // --json output carries the bundle the consume side will import.
    const out = JSON.parse(logs.join("\n"));
    expect(out.gatewayUrl).toBe(GATEWAY_URL);
    expect(out.assistantId).toBe("self");
    expect(out.token).toBe("test-access-token");
    expect(out.deviceId).toBe(body.deviceId);
  });
});
