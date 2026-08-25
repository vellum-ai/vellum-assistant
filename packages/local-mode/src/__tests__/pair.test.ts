import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardianTokenPath } from "../config";
import {
  connectImport,
  pairAssistant,
  pairingCancel,
  pairingPoll,
  pairingStart,
  type PairedAssistantCredentials,
} from "../pair";

let tmpDir: string;
let lockfilePath: string;
let configDir: string;

/** One recorded outbound pairing request. */
interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  redirect: string | undefined;
}

let fetchCalls: FetchCall[];
let respond: (call: FetchCall) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-pair-"));
  lockfilePath = path.join(tmpDir, "lockfile.json");
  configDir = path.join(tmpDir, "config");
  fetchCalls = [];
  respond = () => new Response(null, { status: 500 });
  globalThis.fetch = (async (
    input: unknown,
    init?: { body?: unknown; redirect?: string },
  ): Promise<Response> => {
    const call: FetchCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      redirect: init?.redirect,
    };
    fetchCalls.push(call);
    const response = await respond(call);
    // Mirror the platform: a 3xx under `redirect: "error"` rejects instead of
    // being followed.
    if (
      init?.redirect === "error" &&
      response.status >= 300 &&
      response.status < 400
    ) {
      throw new TypeError("unexpected redirect");
    }
    return response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const readLockfileFromDisk = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as Record<string, unknown>;

const readGuardianToken = (assistantId: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(guardianTokenPath(configDir, assistantId), "utf-8"),
  ) as Record<string, unknown>;

const encodeBundle = (obj: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64");

const credentials = (
  overrides: Partial<PairedAssistantCredentials> = {},
): PairedAssistantCredentials => ({
  gatewayUrl: "http://10.0.0.5:7830",
  token: "test-token",
  deviceId: "dev-aaa",
  ...overrides,
});

/** A syntactically valid JWT whose `exp` is 2030-01-01T00:00:00Z. */
const JWT_EXP_S = 1893456000;
const jwtWithExp = `h.${Buffer.from(JSON.stringify({ exp: JWT_EXP_S })).toString("base64")}.s`;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A 3xx pointing somewhere `parsePairingAddress` would never have allowed. */
const redirectTo = (target: string): Response =>
  new Response(null, { status: 307, headers: { Location: target } });

/**
 * A body streamed in 8 KiB chunks, pulled on demand, so a reader that stops
 * early never buffers the rest. `onPull` counts the chunks actually asked for.
 */
const streamedBody = (chunkCount: number, onPull: () => void): Response => {
  const chunk = new Uint8Array(8 * 1024).fill(0x20);
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull();
        if (sent >= chunkCount) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const challengeBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  deviceCode: "device-code-abc",
  userCode: "ABCD-EFGH",
  verificationUri: "https://gw.example.com/assistant/pair",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  expiresInSeconds: 600,
  intervalSeconds: 3,
  ...overrides,
});

const approvedBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "approved",
  accessToken: "acc-tok",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshAfter: new Date(Date.now() + 1_800_000).toISOString(),
  guardianId: "guardian-1",
  assistantId: "self",
  refreshToken: "refresh-tok",
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

const pendingBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "pending",
  expiresAt: new Date(Date.now() + 500_000).toISOString(),
  intervalSeconds: 7,
  ...overrides,
});

describe("pairAssistant", () => {
  test("writes the lockfile entry and guardian token with the exact CLI shapes and modes", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ token: jwtWithExp, deviceId: "dev-aaa" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toBe("paired-dev-aaa");
    expect(result.updated).toBe(false);
    expect(result.accessOnly).toBe(true);

    // The on-disk entry matches what `vellum connect import` writes, field for
    // field and in the same key order.
    const onDisk = readLockfileFromDisk();
    const entry = (onDisk.assistants as Array<Record<string, unknown>>)[0]!;
    expect(entry).toEqual({
      assistantId: "paired-dev-aaa",
      name: "paired (10.0.0.5:7830)",
      runtimeUrl: "http://10.0.0.5:7830",
      cloud: "paired",
      paired: true,
      species: "vellum",
    });
    expect(Object.keys(entry)).toEqual([
      "assistantId",
      "name",
      "runtimeUrl",
      "cloud",
      "paired",
      "species",
    ]);
    // Importing never reassigns the active assistant.
    expect(onDisk.activeAssistant ?? null).toBeNull();

    const tokenPath = guardianTokenPath(configDir, "paired-dev-aaa");
    const raw = fs.readFileSync(tokenPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const token = JSON.parse(raw) as Record<string, unknown>;
    const { leasedAt, ...rest } = token;
    expect(rest).toEqual({
      guardianPrincipalId: "imported",
      accessToken: jwtWithExp,
      accessTokenExpiresAt: JWT_EXP_S * 1000,
      refreshToken: "",
      refreshTokenExpiresAt: 0,
      refreshAfter: "",
      isNew: false,
      deviceId: "dev-aaa",
      pairedGatewayUrl: "http://10.0.0.5:7830",
    });
    expect(new Date(leasedAt as string).toISOString()).toBe(leasedAt as string);
    expect(Object.keys(token)).toEqual([
      "guardianPrincipalId",
      "accessToken",
      "accessTokenExpiresAt",
      "refreshToken",
      "refreshTokenExpiresAt",
      "refreshAfter",
      "isNew",
      "deviceId",
      "leasedAt",
      "pairedGatewayUrl",
    ]);

    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700);
  });

  test("falls back to now+24h expiry for a non-JWT access token", () => {
    const before = Date.now();
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ token: "opaque-token", deviceId: "dev-exp" }),
    });
    expect(result.ok).toBe(true);

    const token = readGuardianToken("paired-dev-exp");
    const dayMs = 24 * 60 * 60 * 1000;
    expect(token.accessTokenExpiresAt as number).toBeGreaterThanOrEqual(
      before + dayMs,
    );
    expect(token.accessTokenExpiresAt as number).toBeLessThanOrEqual(
      Date.now() + dayMs,
    );
  });

  test("persists the refresh credential and reports accessOnly: false", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com",
        deviceId: "dev-refresh",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
        refreshAfter: "2026-07-01T00:00:00.000Z",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.accessOnly).toBe(false);
    const token = readGuardianToken("paired-dev-refresh");
    expect(token.refreshToken).toBe("refresh-tok");
    expect(token.refreshTokenExpiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(token.refreshAfter).toBe("2026-07-01T00:00:00.000Z");
  });

  test("preserves a numeric (epoch-ms) refreshTokenExpiresAt", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com",
        deviceId: "dev-num",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: 1893456000000,
      }),
    });

    expect(result.ok).toBe(true);
    expect(readGuardianToken("paired-dev-num").refreshTokenExpiresAt).toBe(
      1893456000000,
    );
  });

  test("refuses loopback gateway URLs so a pairing can't alias local services", () => {
    // A stored loopback runtimeUrl would otherwise read as a local gateway
    // (e.g. to the loopback proxy allowlist), aliasing arbitrary local ports.
    for (const gatewayUrl of [
      "http://127.0.0.1:5432",
      "http://localhost:7830",
      "http://[::1]:7830",
      "https://127.0.0.1:7830",
      // Wildcard and IPv4-mapped aliases reach local listeners when dialed.
      "http://0.0.0.0:7830",
      "http://0:7830",
      "http://[::]:7830",
      "http://[::ffff:127.0.0.1]:7830",
      "http://[0:0:0:0:0:ffff:127.0.0.1]:7830",
      "http://[::ffff:0.0.0.0]:7830",
    ]) {
      const result = pairAssistant([lockfilePath], configDir, {
        credentials: credentials({ gatewayUrl, deviceId: "dev-loop" }),
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.status).toBe(422);
      expect(result.error).toContain("non-loopback");
    }
    // Nothing was written for any refused pairing.
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(fs.existsSync(guardianTokenPath(configDir, "paired-dev-loop"))).toBe(
      false,
    );
  });

  test("a non-loopback plaintext http gateway is access-only even with a refresh token", () => {
    // refreshGuardianToken refuses to send the refresh token over plaintext
    // LAN URLs, so the pairing can never renew; report it access-only so the
    // expiry warning shows.
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "http://10.0.0.5:7830",
        deviceId: "dev-lan",
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.accessOnly).toBe(true);
  });

  test("a name is slugified into the id while the entry keeps the raw name", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "Desk Box",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toBe("desk-box");
    const entry = (
      readLockfileFromDisk().assistants as Array<Record<string, unknown>>
    )[0]!;
    expect(entry.name).toBe("Desk Box");
  });

  test("a name with no alphanumerics is refused with a 400", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "!!!",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(400);
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("a malicious deviceId is slugified out of the path", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "-/../../tmp/x" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).not.toContain("/");
    expect(result.assistantId).not.toContain("..");
    expect(
      fs.existsSync(guardianTokenPath(configDir, result.assistantId)),
    ).toBe(true);
  });

  test("a missing deviceId falls back to a random path-safe id", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: undefined }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toMatch(/^paired-[A-Za-z0-9_-]{21}$/);
  });

  test("refuses to clobber an existing non-paired assistant", () => {
    writeLockfile({
      assistants: [
        {
          assistantId: "desk",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:7830",
        },
      ],
      activeAssistant: "desk",
    });

    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "desk",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(409);
    expect(result.assistantId).toBe("desk");
    // Nothing was written: the entry is untouched and no token exists.
    expect(readLockfileFromDisk().assistants).toEqual([
      {
        assistantId: "desk",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:7830",
      },
    ]);
    expect(fs.existsSync(guardianTokenPath(configDir, "desk"))).toBe(false);
  });

  test("re-importing over an existing paired entry updates it in place", () => {
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-re", token: "t1" }),
    });
    expect(first.ok).toBe(true);

    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        deviceId: "dev-re",
        token: "t2",
        gatewayUrl: "https://new.example.com",
      }),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.updated).toBe(true);
    const assistants = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.runtimeUrl).toBe("https://new.example.com");
    expect(readGuardianToken("paired-dev-re").accessToken).toBe("t2");
  });

  test("deletes the just-written token when the lockfile write fails", () => {
    // A lockfile path whose parent is a regular file makes the write fail
    // deterministically (unlike chmod, which root ignores) after the token
    // has already been written.
    const notADir = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(notADir, "");
    const tokenPath = guardianTokenPath(configDir, "paired-dev-aaa");

    const result = pairAssistant(
      [path.join(notADir, "lockfile.json")],
      configDir,
      { credentials: credentials() },
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(tokenPath)).toBe(false);
    // The per-assistant directory is cleaned up too.
    expect(fs.existsSync(path.dirname(tokenPath))).toBe(false);
  });

  test("restores the prior token when a re-import's lockfile write fails", () => {
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-re", token: "t1" }),
    });
    expect(first.ok).toBe(true);
    const tokenPath = guardianTokenPath(configDir, "paired-dev-re");
    const priorContents = fs.readFileSync(tokenPath, "utf-8");

    // Reads fall back to the real lockfile (so the existing entry is found
    // and this is a genuine re-import) while the write targets a path whose
    // parent is a regular file and fails deterministically (unlike chmod,
    // which root ignores).
    const notADir = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(notADir, "");
    const result = pairAssistant(
      [path.join(notADir, "lockfile.json"), lockfilePath],
      configDir,
      { credentials: credentials({ deviceId: "dev-re", token: "t2" }) },
    );

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(tokenPath, "utf-8")).toBe(priorContents);
  });

  test("an unparseable gatewayUrl is refused, not thrown", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: "not a url" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(422);
  });
});

describe("pairingStart", () => {
  test("a pairing link opens a session without a request or an approval code", async () => {
    const started = await pairingStart(
      "https://gw.example.com/assistant/pair#device_code=device-code-abc",
    );

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(fetchCalls).toHaveLength(0);
    expect(started.userCode).toBeNull();
    expect(started.handle).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The caller never sees the device code, the device id, or anything else
    // it could replay.
    expect(Object.keys(started).sort()).toEqual([
      "expiresAt",
      "handle",
      "intervalSeconds",
      "ok",
      "userCode",
    ]);
    expect(JSON.stringify(started)).not.toContain("device-code-abc");
  });

  test("a bare URL mints a challenge and returns the approval code", async () => {
    respond = () => json(200, challengeBody());

    const started = await pairingStart("  https://gw.example.com/  ");

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(fetchCalls).toEqual([
      {
        url: "https://gw.example.com/v1/remote-web/pairing-challenge",
        body: { publicBaseUrl: "https://gw.example.com" },
        redirect: "error",
      },
    ]);
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.intervalSeconds).toBe(3);
    expect(JSON.stringify(started)).not.toContain("device-code-abc");
  });

  test("a challenge response missing its codes is a gateway failure", async () => {
    respond = () => json(200, { verificationUri: "https://gw.example.com" });

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("gateway");
    expect(started.status).toBe(502);
  });

  test("a refused challenge is a gateway failure carrying the status", async () => {
    respond = () => json(429, { error: { code: "RATE_LIMITED" } });

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("gateway");
    expect(started.error).toContain("429");
  });

  test("an unreachable assistant is reported as a transport failure", async () => {
    respond = () => {
      throw new TypeError("connection refused");
    };

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("unreachable");
    expect(started.status).toBe(503);
  });

  test("refuses to follow a redirect off the address that was checked", async () => {
    // Without `redirect: "error"` this 307 would carry the POST to a loopback
    // service, walking straight past the address checks.
    respond = () =>
      redirectTo("http://127.0.0.1:7830/v1/remote-web/pairing-challenge");

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("unreachable");
    expect(started.status).toBe(503);
    expect(started.error).toContain("Could not reach that assistant");
    // One request, to the checked address, and it asked not to be redirected.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://gw.example.com/v1/remote-web/pairing-challenge",
    );
    expect(fetchCalls[0]!.redirect).toBe("error");
  });

  test("an over-cap challenge body is refused instead of buffered", async () => {
    let pulls = 0;
    respond = () =>
      streamedBody(1024, () => {
        pulls += 1;
      });

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("gateway");
    expect(started.status).toBe(502);
    expect(started.error).toContain("too large");
    // The read stopped just past the 64 KiB cap rather than draining 8 MiB.
    expect(pulls).toBeLessThan(20);
  });

  test("rejects addresses that can never reach a remote assistant", async () => {
    const cases: Array<[string, string]> = [
      ["http://localhost:7830", "loopback"],
      ["https://127.0.0.1", "loopback"],
      ["https://10.0.0.1", "private-address"],
      ["https://192.168.1.5", "private-address"],
      // The cloud instance metadata endpoint, the classic blind-SSRF target.
      ["https://169.254.169.254", "private-address"],
      ["https://[fd00::1]", "private-address"],
      ["https://[::ffff:10.0.0.1]", "private-address"],
      ["http://gw.example.com", "non-https"],
      ["https://login.tailscale.com/admin/invite/abc", "service-website"],
      ["not a url", "unparseable"],
    ];

    for (const [address, rejection] of cases) {
      const started = await pairingStart(address);
      expect(started.ok).toBe(false);
      if (started.ok) {
        continue;
      }
      expect(started.reason).toBe("invalid-address");
      expect(started.status).toBe(400);
      expect(started.rejection).toBe(
        rejection as NonNullable<typeof started.rejection>,
      );
    }
    // A refused address never reaches the network.
    expect(fetchCalls).toHaveLength(0);
  });

  test("names the tunnel vendor when the address is its own website", async () => {
    const started = await pairingStart("https://login.tailscale.com/admin");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toContain("Tailscale");
  });

  test("a missing or oversized address is refused before parsing", async () => {
    for (const address of [undefined, "", "   ", 42]) {
      const started = await pairingStart(address);
      expect(started.ok).toBe(false);
      if (started.ok) {
        continue;
      }
      expect(started.reason).toBe("invalid-address");
    }

    const oversized = `https://gw.example.com/${"a".repeat(2 * 1024)}`;
    const started = await pairingStart(oversized);
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.error).toContain("too long");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("pairingPoll", () => {
  const startFromLink = async (
    address = "https://gw.example.com/assistant/pair#device_code=device-code-abc",
  ): Promise<string> => {
    const started = await pairingStart(address);
    if (!started.ok) {
      throw new Error(`unexpected start failure: ${started.error}`);
    }
    return started.handle;
  };

  test("a pre-approved link imports on the first poll", async () => {
    respond = () => json(200, approvedBody());
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, { handle });

    expect(result).toEqual({
      ok: true,
      status: "imported",
      assistantId: expect.stringMatching(/^paired-/) as unknown as string,
      updated: false,
      accessOnly: false,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://gw.example.com/v1/remote-web/pairing-token",
    );
    expect(fetchCalls[0]!.body.deviceCode).toBe("device-code-abc");
    expect(fetchCalls[0]!.body.platform).toBe("desktop");
    expect(fetchCalls[0]!.body.deviceId).toMatch(/^[A-Za-z0-9_-]{21}$/);

    const entry = (
      readLockfileFromDisk().assistants as Array<Record<string, unknown>>
    )[0]!;
    expect(entry).toMatchObject({
      cloud: "paired",
      paired: true,
      // The pair-page path is stripped back to the public base.
      runtimeUrl: "https://gw.example.com",
    });
    const token = readGuardianToken(entry.assistantId as string);
    expect(token.accessToken).toBe("acc-tok");
    expect(token.refreshToken).toBe("refresh-tok");
    expect(token.deviceId).toBe(fetchCalls[0]!.body.deviceId);
  });

  test("a gateway that returns no body refresh token imports access-only", async () => {
    respond = () =>
      json(200, {
        ...approvedBody(),
        refreshToken: undefined,
        refreshTokenExpiresAt: undefined,
      });
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "Desk Box",
    });

    expect(result).toEqual({
      ok: true,
      status: "imported",
      assistantId: "desk-box",
      updated: false,
      accessOnly: true,
    });
    expect(readGuardianToken("desk-box").refreshToken).toBe("");
  });

  test("stays pending until the host approves, adopting the gateway's cadence", async () => {
    respond = () => json(202, pendingBody());
    const handle = await startFromLink();

    const pending = await pairingPoll([lockfilePath], configDir, { handle });
    expect(pending).toEqual({
      ok: true,
      status: "pending",
      expiresAt: expect.any(String) as unknown as string,
      intervalSeconds: 7,
    });
    expect(fs.existsSync(lockfilePath)).toBe(false);

    respond = () => json(200, approvedBody());
    const imported = await pairingPoll([lockfilePath], configDir, { handle });
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.status).toBe("imported");
  });

  test("records the platform the caller names, defaulting to desktop", async () => {
    respond = () => json(202, pendingBody());

    const cliHandle = await startFromLink();
    await pairingPoll([lockfilePath], configDir, {
      handle: cliHandle,
      platform: "cli",
    });
    expect(fetchCalls[0]!.body.platform).toBe("cli");

    const unknownHandle = await startFromLink();
    await pairingPoll([lockfilePath], configDir, {
      handle: unknownHandle,
      platform: "toaster",
    });
    expect(fetchCalls[1]!.body.platform).toBe("desktop");
  });

  test("an expired challenge is refused without spending a request", async () => {
    respond = () =>
      json(
        200,
        challengeBody({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
    const started = await pairingStart("https://gw.example.com");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const result = await pairingPoll([lockfilePath], configDir, {
      handle: started.handle,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("expired");
    expect(result.status).toBe(410);
    // Only the challenge mint went out; the exchange was never attempted.
    expect(fetchCalls).toHaveLength(1);
  });

  test("a denied or expired code ends the session", async () => {
    respond = () =>
      json(401, { error: { code: "INVALID_OR_EXPIRED_DEVICE_CODE" } });
    const handle = await startFromLink();

    const denied = await pairingPoll([lockfilePath], configDir, { handle });
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      return;
    }
    expect(denied.reason).toBe("expired");

    // The session is gone, so a further poll cannot replay the spent code.
    const again = await pairingPoll([lockfilePath], configDir, { handle });
    expect(again.ok).toBe(false);
    if (again.ok) {
      return;
    }
    expect(again.reason).toBe("unknown-session");
    expect(fetchCalls).toHaveLength(1);
  });

  test("a transport failure leaves the session pollable", async () => {
    respond = () => {
      throw new TypeError("connection reset");
    };
    const handle = await startFromLink();

    const failed = await pairingPoll([lockfilePath], configDir, { handle });
    expect(failed.ok).toBe(false);
    if (failed.ok) {
      return;
    }
    expect(failed.reason).toBe("unreachable");

    respond = () => json(200, approvedBody());
    const imported = await pairingPoll([lockfilePath], configDir, { handle });
    expect(imported.ok).toBe(true);
  });

  test("an unusable approval body is a gateway failure", async () => {
    respond = () => json(200, { status: "approved" });
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, { handle });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("gateway");
    expect(fs.existsSync(lockfilePath)).toBe(false);
    // The gateway spent the code before replying, so the session is dead.
    expect(pairingCancel(handle)).toBe(false);
  });

  test.each([
    ["an empty accessToken", { accessToken: "" }],
    ["a non-string accessToken", { accessToken: 42 }],
    ["a non-string refreshToken", { refreshToken: 7 }],
    ["an object refreshTokenExpiresAt", { refreshTokenExpiresAt: {} }],
    ["a non-string refreshAfter", { refreshAfter: 900 }],
    // Refresh fields are all-or-none: a partial set would persist a zero
    // expiry while reporting the pairing as renewable.
    ["a refresh token but no expiry", { refreshTokenExpiresAt: undefined }],
    ["an expiry but no refresh token", { refreshToken: undefined }],
    ["an expiry but an empty refresh token", { refreshToken: "" }],
    ["a zero refreshTokenExpiresAt", { refreshTokenExpiresAt: 0 }],
    ["a negative refreshTokenExpiresAt", { refreshTokenExpiresAt: -1 }],
    ["an unparseable refreshTokenExpiresAt", { refreshTokenExpiresAt: "soon" }],
  ])(
    "a reply with %s is a gateway failure, not a half-written credential",
    async (_label, overrides) => {
      respond = () => json(200, approvedBody(overrides));
      const handle = await startFromLink();

      const result = await pairingPoll([lockfilePath], configDir, { handle });

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe("gateway");
      expect(result.status).toBe(502);
      // Nothing was persisted: no lockfile entry and no guardian token.
      expect(fs.existsSync(lockfilePath)).toBe(false);
      expect(fs.existsSync(path.join(configDir, "assistants"))).toBe(false);
      // The gateway spent the code before replying, so the session is dead.
      expect(pairingCancel(handle)).toBe(false);
    },
  );

  test("a reply with no refresh fields at all still imports access-only", async () => {
    respond = () =>
      json(200, {
        status: "approved",
        accessToken: "acc-tok",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        guardianId: "guardian-1",
        assistantId: "self",
      });
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "Old Gateway",
    });

    expect(result).toEqual({
      ok: true,
      status: "imported",
      assistantId: "old-gateway",
      updated: false,
      accessOnly: true,
    });
    const token = readGuardianToken("old-gateway");
    expect(token.accessToken).toBe("acc-tok");
    expect(token.refreshToken).toBe("");
    expect(token.refreshAfter).toBe("");
    expect(token.refreshTokenExpiresAt).toBe(0);
  });

  test("a numeric refreshTokenExpiresAt is kept rather than dropped", async () => {
    const expiresAtMs = Date.now() + 86_400_000;
    respond = () =>
      json(200, approvedBody({ refreshTokenExpiresAt: expiresAtMs }));
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "Numeric Expiry",
    });

    expect(result.ok).toBe(true);
    expect(readGuardianToken("numeric-expiry").refreshTokenExpiresAt).toBe(
      expiresAtMs,
    );
  });

  test("a local write refusal surfaces as an import failure", async () => {
    writeLockfile({
      assistants: [
        {
          assistantId: "desk",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:7830",
        },
      ],
      activeAssistant: "desk",
    });
    respond = () => json(200, approvedBody());
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "desk",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("import");
    expect(result.status).toBe(409);
    expect(result.error).toContain("already exists");
  });

  test("a redirected token exchange is refused and stays pollable", async () => {
    respond = () => redirectTo("http://169.254.169.254/latest/meta-data/");
    const handle = await startFromLink();

    const redirected = await pairingPoll([lockfilePath], configDir, { handle });

    expect(redirected.ok).toBe(false);
    if (redirected.ok) {
      return;
    }
    expect(redirected.reason).toBe("unreachable");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://gw.example.com/v1/remote-web/pairing-token",
    );
    expect(fetchCalls[0]!.redirect).toBe("error");

    respond = () => json(200, approvedBody());
    const retried = await pairingPoll([lockfilePath], configDir, { handle });
    expect(retried.ok).toBe(true);
  });

  test("an over-cap approval body is a gateway failure", async () => {
    let pulls = 0;
    respond = () =>
      streamedBody(1024, () => {
        pulls += 1;
      });
    const handle = await startFromLink();

    const result = await pairingPoll([lockfilePath], configDir, { handle });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("gateway");
    expect(result.error).toContain("too large");
    expect(pulls).toBeLessThan(20);
    // Nothing was imported from a body that was never parsed.
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("an unknown handle is refused without a request", async () => {
    for (const handle of ["nope", "", undefined, 42]) {
      const result = await pairingPoll([lockfilePath], configDir, { handle });
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.reason).toBe("unknown-session");
      expect(result.status).toBe(404);
    }
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("pairingCancel", () => {
  test("drops a live session so it can no longer be polled", async () => {
    const started = await pairingStart(
      "https://gw.example.com/assistant/pair#device_code=device-code-abc",
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    expect(pairingCancel(started.handle)).toBe(true);
    // A second cancel is a no-op, and the handle is dead.
    expect(pairingCancel(started.handle)).toBe(false);

    const result = await pairingPoll([lockfilePath], configDir, {
      handle: started.handle,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unknown-session");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a non-string handle is refused rather than throwing", () => {
    expect(pairingCancel(undefined)).toBe(false);
    expect(pairingCancel(7)).toBe(false);
  });
});

describe("connectImport", () => {
  test("registers a valid bundle and returns the wire-shaped success", () => {
    const result = connectImport([lockfilePath], configDir, {
      bundle: ` ${encodeBundle({
        gatewayUrl: "https://gw.example.com",
        token: "tok",
        deviceId: "dev-ci",
      })} `,
      name: "Desk Box",
    });

    expect(result).toEqual({
      ok: true,
      assistantId: "desk-box",
      updated: false,
      accessOnly: true,
    });
    expect(fs.existsSync(guardianTokenPath(configDir, "desk-box"))).toBe(true);
    const entry = (
      readLockfileFromDisk().assistants as Array<Record<string, unknown>>
    )[0]!;
    expect(entry).toMatchObject({
      assistantId: "desk-box",
      cloud: "paired",
      paired: true,
      runtimeUrl: "https://gw.example.com",
    });
  });

  test("a missing, empty, or non-string bundle is a 400", () => {
    for (const value of [undefined, "", 42]) {
      expect(
        connectImport([lockfilePath], configDir, { bundle: value }),
      ).toEqual({
        ok: false,
        status: 400,
        error: "Missing pairing bundle",
      });
    }
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("an oversized bundle is refused before decoding", () => {
    expect(
      connectImport([lockfilePath], configDir, {
        bundle: "a".repeat(64 * 1024 + 1),
      }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "Pairing bundle is too large",
    });
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("a loopback gatewayUrl keeps pairAssistant's 422 and refusal copy", () => {
    const result = connectImport([lockfilePath], configDir, {
      bundle: encodeBundle({
        gatewayUrl: "http://127.0.0.1:5432",
        token: "tok",
        deviceId: "dev-loop",
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(422);
    expect(result.error).toContain("non-loopback");
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("a malformed bundle maps the decode error to a 400", () => {
    const result = connectImport([lockfilePath], configDir, {
      bundle: "not-base64-json!!!",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(400);
    expect(result.error).toContain("base64");
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("an overwrite refusal keeps pairAssistant's 409 and error string", () => {
    writeLockfile({
      assistants: [
        {
          assistantId: "desk",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:7830",
        },
      ],
      activeAssistant: "desk",
    });

    const result = connectImport([lockfilePath], configDir, {
      bundle: encodeBundle({
        gatewayUrl: "https://gw.example.com",
        token: "tok",
      }),
      name: "desk",
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "An assistant named 'desk' already exists",
    });
    expect(fs.existsSync(guardianTokenPath(configDir, "desk"))).toBe(false);
  });

  test("a non-string name is ignored rather than slugified", () => {
    const result = connectImport([lockfilePath], configDir, {
      bundle: encodeBundle({
        gatewayUrl: "https://gw.example.com",
        token: "tok",
        deviceId: "dev-nn",
      }),
      name: 7,
    });

    expect(result).toEqual({
      ok: true,
      assistantId: "paired-dev-nn",
      updated: false,
      accessOnly: true,
    });
  });
});
