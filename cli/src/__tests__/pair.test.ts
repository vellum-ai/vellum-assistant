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

import { buildAppConnectUrl, pair } from "../commands/pair.js";

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

  test("rejects an unknown --flag before any network call", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--frobnicate"];
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

    // A `--` flag this version doesn't know is a hard error, and it points at
    // the CLI self-update path — never a silent fall-through to another flow.
    expect(exited).toBe(true);
    const joined = errors.join("\n");
    expect(joined).toContain("unknown option '--frobnicate'");
    expect(joined).toContain("your CLI may be out of date");
    expect(joined).toContain("bun install -g vellum@latest");
    expect(fetchCalled).toBe(false);
  });

  test("rejects an unknown --flag even alongside a multi-word positional name", async () => {
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

    // Positional name tokens must not rescue an unknown flag from rejection.
    process.argv = ["bun", "vellum", "pair", "My", "Assistant", "--frobnicate"];
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("unknown option '--frobnicate'");
    expect(fetchCalled).toBe(false);
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

    // The refusal cross-points to the QR flow (the phone-pairing path) and its
    // https prerequisite, so a user who wanted a QR isn't left at a dead end.
    expect(errors.join("\n")).toContain("vellum pair --qr");
    expect(errors.join("\n")).toContain("vellum tunnel --provider tailscale");

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

  test("--web creates a browser pairing URL without printing tokens", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri:
              "https://abc123.ngrok.app/assistant-123/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
            intervalSeconds: 5,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--web",
      "--url",
      "https://abc123.ngrok.app/assistant-123/assistant/",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(`${LOCAL_URL}/v1/remote-web/pairing-challenge`);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      publicBaseUrl: "https://abc123.ngrok.app/assistant-123",
    });

    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual({
      pairUrl:
        "https://abc123.ngrok.app/assistant-123/assistant/pair#device_code=device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://abc123.ngrok.app/assistant-123/assistant/pair",
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    });
    expect(logs.join("\n")).not.toContain("access");
    expect(logs.join("\n")).not.toContain("refresh");
  });

  test("--web refuses when the web remote ingress feature flag is off", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          flags: [{ key: "web-remote-ingress", enabled: false }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--web",
      "--url",
      "https://abc123.ngrok.app",
    ];
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("web-remote-ingress");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(
      `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`,
    );
  });

  test("--web-approve approves a browser pairing code over loopback", async () => {
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

    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://abc123.ngrok.app/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--web-approve",
      "ABCD-EFGH",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(`${LOCAL_URL}/v1/remote-web/pairing-verification`);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      userCode: "ABCD-EFGH",
    });
    expect(JSON.parse(logs.join("\n"))).toEqual({
      status: "approved",
      verificationUri: "https://abc123.ngrok.app/assistant/pair",
      expiresAt: "2026-06-04T00:10:00.000Z",
    });
  });

  test("--qr mints a challenge, auto-approves it, and emits a device-code link", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "https://pair.example.ts.net",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Flag check → create challenge → approve it, all over loopback. The
    // approval is the whole point: running the CLI on the host IS the approval,
    // so the scan alone completes pairing.
    expect(calls.map((c) => c[0])).toEqual([
      `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`,
      `${LOCAL_URL}/v1/remote-web/pairing-challenge`,
      `${LOCAL_URL}/v1/remote-web/pairing-verification`,
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      publicBaseUrl: "https://pair.example.ts.net",
    });
    expect(JSON.parse(calls[2][1]?.body as string)).toEqual({
      userCode: "ABCD-EFGH",
    });

    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual({
      pairUrl:
        "https://pair.example.ts.net/assistant/pair#device_code=device-code",
      deviceCode: "device-code",
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    });
    // The device code rides the fragment only — never the path or query.
    const parsed = new URL(out.pairUrl);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#device_code=device-code");
  });

  test("--qr renders a QR and prints the fallback URL and expiry", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          status: "approved",
          verificationUri: "https://pair.example.ts.net/assistant/pair",
          expiresAt: "2026-06-04T00:10:00.000Z",
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "https://pair.example.ts.net",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const output = logs.join("\n");
    expect(output).toContain(
      "https://pair.example.ts.net/assistant/pair#device_code=device-code",
    );
    expect(output).toContain("Expires: 2026-06-04T00:10:00.000Z");
  });

  test("--qr refuses a non-https --url without minting", async () => {
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "http://pair.example.com",
    ];
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

    // Validation is local and fails fast — no challenge minted for a dead link.
    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("https");
    expect(fetchCalled).toBe(false);
  });

  test("--qr refuses a loopback --url without minting", async () => {
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "http://127.0.0.1:7830",
    ];
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("loopback");
    expect(fetchCalled).toBe(false);
  });

  test("--qr refuses an unparseable --url with an accurate error, not a non-https mislabel", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--qr", "--url", "not-a-url"];
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

    // Unparseable input reports its own reason — not the loopback/non-https
    // messages the reason-blind version reconstructed.
    expect(exited).toBe(true);
    const joined = errors.join("\n");
    expect(joined).toContain("isn't a valid URL");
    expect(joined).not.toContain("is not https");
    expect(joined).not.toContain("loopback");
    expect(fetchCalled).toBe(false);
  });

  test("--qr refuses a tunnel-provider website URL (Tailscale admin invite) without minting", async () => {
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "https://login.tailscale.com/admin/invite/abc123",
    ];
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

    // The admin-invite link is a vendor website — named as such, not mislabeled
    // as non-https, and refused before any challenge is minted.
    expect(exited).toBe(true);
    const joined = errors.join("\n");
    expect(joined).toContain("Tailscale's website");
    expect(joined).not.toContain("is not https");
    expect(fetchCalled).toBe(false);
  });

  test("--qr refuses when the web remote ingress feature flag is off", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          flags: [{ key: "web-remote-ingress", enabled: false }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "https://pair.example.ts.net",
    ];
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

    // Only the flag check runs; no challenge is minted when the flag is off.
    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("web-remote-ingress");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(
      `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`,
    );
  });

  test("buildAppConnectUrl composes and encodes the connect link", () => {
    expect(
      buildAppConnectUrl(
        "vellum-assistant",
        "https://pair.example.ts.net",
        "device-code",
      ),
    ).toBe(
      "vellum-assistant://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code",
    );
    // Path prefixes and fragment-hostile characters survive the encoding.
    expect(
      buildAppConnectUrl(
        "vellum-assistant-dev",
        "https://host.example.ts.net/assistant-123",
        "a+b/c=",
      ),
    ).toBe(
      "vellum-assistant-dev://connect?url=https%3A%2F%2Fhost.example.ts.net%2Fassistant-123&code=a%2Bb%2Fc%3D",
    );
  });

  test("--qr --app emits an app connect URL alongside the browser URL", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://pair.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--app",
      "--app-scheme",
      "vellum-assistant-dev",
      "--url",
      "https://pair.example.ts.net",
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const out = JSON.parse(logs.join("\n"));
    expect(out.appUrl).toBe(
      "vellum-assistant-dev://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code",
    );
    // The browser URL stays available as the no-app fallback.
    expect(out.pairUrl).toBe(
      "https://pair.example.ts.net/assistant/pair#device_code=device-code",
    );
    expect(out.deviceCode).toBe("device-code");
  });

  test("--app without --qr is refused", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--app"];
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain("--qr");
    expect(fetchCalled).toBe(false);
  });

  function writeLockfileWithIngress(ingressUrl: string): void {
    writeFileSync(
      join(testDir, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "pair-test",
            runtimeUrl: RUNTIME_URL,
            localUrl: LOCAL_URL,
            cloud: "local",
            ingressUrl,
          },
        ],
        activeAssistant: "pair-test",
      }),
    );
  }

  test("--qr with no --url uses the entry's tunnel-recorded ingress URL", async () => {
    writeLockfileWithIngress("https://saved.example.ts.net");

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        // The minted challenge must advertise the entry's recorded URL.
        expect(JSON.parse(init?.body as string)).toEqual({
          publicBaseUrl: "https://saved.example.ts.net",
        });
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://saved.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://saved.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "vellum", "pair", "--qr"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(calls).toContain(`${LOCAL_URL}/v1/remote-web/pairing-challenge`);
    const output = logs.join("\n");
    expect(output).toContain(
      "Using saved ingress URL https://saved.example.ts.net",
    );
    expect(output).toContain(
      "https://saved.example.ts.net/assistant/pair#device_code=device-code",
    );
  });

  test("--url beats the entry's recorded ingress URL", async () => {
    writeLockfileWithIngress("https://saved.example.ts.net");

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
        expect(JSON.parse(init?.body as string)).toEqual({
          publicBaseUrl: "https://explicit.example.ts.net",
        });
        return new Response(
          JSON.stringify({
            deviceCode: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://explicit.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
            expiresInSeconds: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
        return new Response(
          JSON.stringify({
            status: "approved",
            verificationUri: "https://explicit.example.ts.net/assistant/pair",
            expiresAt: "2026-06-04T00:10:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "--qr",
      "--url",
      "https://explicit.example.ts.net",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    expect(logs.join("\n")).not.toContain("Using saved ingress URL");
  });

  test("a non-https recorded ingress URL is ignored", async () => {
    writeLockfileWithIngress("http://insecure.example.com");

    const origFetch = globalThis.fetch;
    let minted = false;
    globalThis.fetch = (async (url: string) => {
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      minted = true;
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

    process.argv = ["bun", "vellum", "pair", "--qr"];
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

    // The recorded http URL is skipped, so --qr falls through to the
    // (non-https) runtime URL and refuses — proving it was not advertised.
    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain(RUNTIME_URL);
    expect(minted).toBe(false);
  });

  test("a loopback recorded ingress URL is ignored", async () => {
    writeLockfileWithIngress("https://127.0.0.1:7840");

    const origFetch = globalThis.fetch;
    let minted = false;
    globalThis.fetch = (async (url: string) => {
      if (url === `${LOCAL_URL}/v1/assistants/pair-test/feature-flags`) {
        return new Response(
          JSON.stringify({
            flags: [{ key: "web-remote-ingress", enabled: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      minted = true;
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

    process.argv = ["bun", "vellum", "pair", "--qr"];
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain(RUNTIME_URL);
    expect(minted).toBe(false);
  });
});
