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

// Real assistant-config reads the lockfile from VELLUM_LOCKFILE_DIR. Pin the
// environment too: the lockfile filename is environment-dependent, and a dev
// machine's persisted default environment would otherwise redirect the lookup.
const testDir = mkdtempSync(join(tmpdir(), "pair-command-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;
const originalEnvironment = process.env.VELLUM_ENVIRONMENT;
process.env.VELLUM_ENVIRONMENT = "production";

import { buildAppConnectUrl, pair } from "../commands/pair.js";

// Distinct loopback (mint) vs reachable (advertised) URLs to verify the split.
const LOCAL_URL = "http://127.0.0.1:7830";
const RUNTIME_URL = "http://192.168.1.50:7830";
const PUBLIC_URL = "https://pair.example.ts.net";

function challengeResponse(baseUrl = PUBLIC_URL): Response {
  return new Response(
    JSON.stringify({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUri: `${baseUrl}/assistant/pair`,
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function approvalResponse(baseUrl = PUBLIC_URL): Response {
  return new Response(
    JSON.stringify({
      status: "approved",
      verificationUri: `${baseUrl}/assistant/pair`,
      expiresAt: "2026-06-04T00:10:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Answer the challenge + verification pair minted over loopback. */
function stubPairingGateway(
  calls: Array<[string, RequestInit | undefined]>,
  baseUrl = PUBLIC_URL,
): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (url === `${LOCAL_URL}/v1/remote-web/pairing-challenge`) {
      return challengeResponse(baseUrl);
    }
    if (url === `${LOCAL_URL}/v1/remote-web/pairing-verification`) {
      return approvalResponse(baseUrl);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

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
    if (originalEnvironment === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = originalEnvironment;
    }
  });

  test("mints a challenge, approves it locally, and prints the link plus a QR", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "vellum", "pair", "--url", PUBLIC_URL];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint over the loopback gateway, then approve: running this command on
    // the host IS the approval, so the link alone completes the pairing.
    expect(calls.map((c) => c[0])).toEqual([
      `${LOCAL_URL}/v1/remote-web/pairing-challenge`,
      `${LOCAL_URL}/v1/remote-web/pairing-verification`,
    ]);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      publicBaseUrl: PUBLIC_URL,
    });
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
      userCode: "ABCD-EFGH",
    });

    const output = logs.join("\n");
    // One artifact, two renderings: the link and the same link as a QR.
    expect(output).toContain(
      `${PUBLIC_URL}/assistant/pair#device_code=device-code`,
    );
    expect(output).toContain("\u2588");
    expect(output).toContain("vellum connect import");
    expect(output).toContain("Expires: 2026-06-04T00:10:00.000Z");
    // The base64 bundle is gone: no blob, and no hand-this-over copy.
    expect(output).not.toContain("Hand this to the other machine");
    expect(output).not.toMatch(/eyJ[A-Za-z0-9+/=]{20,}/);
  });

  test("--json emits the pairing link, device code, and expiry", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "vellum", "pair", "--url", PUBLIC_URL, "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual({
      pairUrl: `${PUBLIC_URL}/assistant/pair#device_code=device-code`,
      deviceCode: "device-code",
      expiresAt: "2026-06-04T00:10:00.000Z",
      expiresInSeconds: 600,
    });
    // The device code rides the fragment only, never the path or query.
    const parsed = new URL(out.pairUrl);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#device_code=device-code");
    // No credential ever reaches the output.
    expect(logs.join("\n")).not.toContain("token");
  });

  test("--qr is a silent no-op, identical to a flagless run", async () => {
    // Shipped iOS builds tell users to run `vellum pair --qr` (see
    // clients/ios/App/App/Settings.bundle/Root.plist), copy those installs can
    // never receive an update for, so the flag stays accepted and ignored.
    const origFetch = globalThis.fetch;

    async function runPair(argv: string[]): Promise<{
      urls: string[];
      output: string;
    }> {
      const calls: Array<[string, RequestInit | undefined]> = [];
      stubPairingGateway(calls);
      const logs: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation(
        (...a: unknown[]) => {
          logs.push(a.join(" "));
        },
      );
      const errSpy = spyOn(console, "error").mockImplementation(
        (...a: unknown[]) => {
          logs.push(`ERROR ${a.join(" ")}`);
        },
      );
      process.argv = argv;
      try {
        await pair();
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      return { urls: calls.map((c) => c[0]), output: logs.join("\n") };
    }

    let plain: { urls: string[]; output: string };
    let withQr: { urls: string[]; output: string };
    try {
      plain = await runPair(["bun", "vellum", "pair", "--url", PUBLIC_URL]);
      withQr = await runPair([
        "bun",
        "vellum",
        "pair",
        "--qr",
        "--url",
        PUBLIC_URL,
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(withQr.urls).toEqual(plain.urls);
    expect(withQr.output).toBe(plain.output);
    // Accepted, not retired: no migration error, and the QR still prints.
    expect(withQr.output).not.toContain("no longer an option");
    expect(withQr.output).toContain("\u2588");
  });

  test("--qr is not advertised in the help output", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );
    process.argv = ["bun", "vellum", "pair", "--help"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain("--qr");
  });

  test("--app-scheme without --app is refused rather than ignored", async () => {
    // A scheme only names the app link, so accepting it alone would print the
    // https QR and drop the scheme silently.
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
      "--app-scheme",
      "vellum-assistant-dev",
      "--url",
      PUBLIC_URL,
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
    expect(errors.join("\n")).toContain("--app-scheme");
    expect(errors.join("\n")).toContain("--app");
    // Refused before anything is minted.
    expect(fetchCalled).toBe(false);
  });

  test("--web is refused, pointing at connect import on the other device", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--web", "--url", PUBLIC_URL];
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
    const joined = errors.join("\n");
    expect(joined).toContain("--web is no longer an option");
    expect(joined).toContain("vellum connect import");
    expect(joined).toContain("--web-approve");
    expect(fetchCalled).toBe(false);
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

    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    process.argv = [
      "bun",
      "vellum",
      "pair",
      "My",
      "Assistant",
      "--url",
      PUBLIC_URL,
      "--json",
    ];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Resolution succeeded (no exit), so the challenge was minted.
    expect(calls.map((c) => c[0])).toEqual([
      `${LOCAL_URL}/v1/remote-web/pairing-challenge`,
      `${LOCAL_URL}/v1/remote-web/pairing-verification`,
    ]);
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

  test("refuses a loopback runtime URL without --url, before minting", async () => {
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

    // The refusal names the address it refused and both ways forward: an
    // explicit --url, or a tunnel when there is no public address yet.
    const joined = errors.join("\n");
    expect(joined).toContain(LOOPBACK_CUSTOM);
    expect(joined).toContain("loopback");
    expect(joined).toContain("vellum pair --url");
    expect(joined).toContain("vellum tunnel --provider tailscale");

    // Exited before minting, so no challenge exists for a dead link.
    expect(exited).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("--url override wins over a loopback runtime URL", async () => {
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

    const OVERRIDE = "https://abc123.ngrok.app";
    const calls: Array<[string, RequestInit | undefined]> = [];
    const origFetch = globalThis.fetch;
    stubPairingGateway(calls, OVERRIDE);
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => {
        logs.push(a.join(" "));
      },
    );

    process.argv = ["bun", "vellum", "pair", "--url", OVERRIDE, "--json"];
    try {
      await pair();
    } finally {
      logSpy.mockRestore();
      globalThis.fetch = origFetch;
    }

    // Mint still over loopback; the link advertises the override.
    expect(calls[0][0]).toBe(`${LOCAL_URL}/v1/remote-web/pairing-challenge`);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      publicBaseUrl: OVERRIDE,
    });
    expect(JSON.parse(logs.join("\n")).pairUrl).toBe(
      `${OVERRIDE}/assistant/pair#device_code=device-code`,
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

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${LOCAL_URL}/v1/remote-web/pairing-verification`);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({
      userCode: "ABCD-EFGH",
    });
    expect(JSON.parse(logs.join("\n"))).toEqual({
      status: "approved",
      verificationUri: "https://abc123.ngrok.app/assistant/pair",
      expiresAt: "2026-06-04T00:10:00.000Z",
    });
  });

  test("refuses a non-https --url without minting", async () => {
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

  test("refuses a loopback --url without minting", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--url", "http://127.0.0.1:7830"];
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

  test("refuses an unparseable --url with an accurate error, not a non-https mislabel", async () => {
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

    process.argv = ["bun", "vellum", "pair", "--url", "not-a-url"];
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

  test("refuses a tunnel-provider website URL (Tailscale admin invite) without minting", async () => {
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
    // A label rides along as an encoded `name` param (spaces percent-encoded,
    // not form-encoded, for the app's URLComponents parser); an empty one is
    // omitted.
    expect(
      buildAppConnectUrl(
        "vellum-assistant",
        "https://pair.example.ts.net",
        "device-code",
        "My Homelab",
      ),
    ).toBe(
      "vellum-assistant://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=My%20Homelab",
    );
    expect(
      buildAppConnectUrl(
        "vellum-assistant",
        "https://pair.example.ts.net",
        "device-code",
        "",
      ),
    ).toBe(
      "vellum-assistant://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code",
    );
  });

  test("--app emits an app connect URL alongside the browser URL", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
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
    // Without --label the connect link names the assistant after its lockfile
    // display name (the id here, since the entry has no name).
    expect(out.appUrl).toBe(
      "vellum-assistant-dev://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=pair-test",
    );
    // The browser URL stays available as the no-app fallback.
    expect(out.pairUrl).toBe(
      "https://pair.example.ts.net/assistant/pair#device_code=device-code",
    );
    expect(out.deviceCode).toBe("device-code");
  });

  test("--app --label overrides the assistant name in the connect link", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
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
      "--app",
      "--label",
      "Homelab",
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
      "vellum-assistant://connect?url=https%3A%2F%2Fpair.example.ts.net&code=device-code&name=Homelab",
    );
  });

  test("--app is refused alongside --web-approve", async () => {
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
      "--app",
      "--web-approve",
      "ABCD-EFGH",
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
    expect(errors.join("\n")).toContain("--web-approve");
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

  test("with no --url, the entry's tunnel-recorded ingress URL is used", async () => {
    writeLockfileWithIngress("https://saved.example.ts.net");

    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
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

    process.argv = ["bun", "vellum", "pair"];
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
    globalThis.fetch = (async () => {
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

    // The recorded http URL is skipped, so the flow falls through to the
    // (non-https) runtime URL and refuses, proving it was not advertised.
    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain(RUNTIME_URL);
    expect(minted).toBe(false);
  });

  test("a loopback recorded ingress URL is ignored", async () => {
    writeLockfileWithIngress("https://127.0.0.1:7840");

    const origFetch = globalThis.fetch;
    let minted = false;
    globalThis.fetch = (async () => {
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

    expect(exited).toBe(true);
    expect(errors.join("\n")).toContain(RUNTIME_URL);
    expect(minted).toBe(false);
  });
});
