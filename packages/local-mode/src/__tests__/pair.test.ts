import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pairingSessionSurvives } from "@vellumai/service-contracts/remote-web-pairing";

import { guardianTokenPath } from "../config";
import {
  checkPairedAssistantName,
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
  signal: AbortSignal | undefined;
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
    init?: { body?: unknown; redirect?: string; signal?: AbortSignal },
  ): Promise<Response> => {
    const call: FetchCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      redirect: init?.redirect,
      signal: init?.signal,
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

/** The nameless id the default credentials' gateway host derives. */
const DEFAULT_PAIRED_ID = "paired-10-0-0-5-7830";

/** A syntactically valid JWT whose `exp` is 2030-01-01T00:00:00Z. */
const JWT_EXP_S = 1893456000;
const jwtWithExp = `h.${Buffer.from(JSON.stringify({ exp: JWT_EXP_S })).toString("base64")}.s`;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * A reply whose JSON is written out literally, so a value `JSON.stringify`
 * cannot express reaches the parser exactly as a remote sends it. `1e400`
 * parses back as Infinity, which is how a hostile or broken assistant names an
 * unbounded cadence.
 */
const rawJson = (status: number, text: string): Response =>
  new Response(text, {
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

/** Resolve once `count` pairing requests are actually in flight. */
const requestsInFlight = async (count: number): Promise<void> => {
  while (fetchCalls.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("pairAssistant", () => {
  test("writes the lockfile entry and guardian token with the exact CLI shapes and modes", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ token: jwtWithExp, deviceId: "dev-aaa" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toBe(DEFAULT_PAIRED_ID);
    expect(result.updated).toBe(false);
    expect(result.accessOnly).toBe(true);

    // The on-disk entry matches what `vellum connect import` writes, field for
    // field and in the same key order.
    const onDisk = readLockfileFromDisk();
    const entry = (onDisk.assistants as Array<Record<string, unknown>>)[0]!;
    expect(entry).toEqual({
      assistantId: DEFAULT_PAIRED_ID,
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

    const tokenPath = guardianTokenPath(configDir, DEFAULT_PAIRED_ID);
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

    const token = readGuardianToken(DEFAULT_PAIRED_ID);
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
    const token = readGuardianToken("paired-gw-example-com");
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
    expect(
      readGuardianToken("paired-gw-example-com").refreshTokenExpiresAt,
    ).toBe(1893456000000);
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
    expect(fs.existsSync(path.join(configDir, "assistants"))).toBe(false);
  });

  test("a loopback refusal points at an address that can still work", () => {
    // Private-network literals are refused before a pairing is ever minted, so
    // advice to retry with a LAN address would send the user into a guaranteed
    // second failure.
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: "http://localhost:7830" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("tunnel or public https address");
    expect(result.error).not.toContain("LAN");
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

  test("the derived id is path-safe whatever the deviceId carries", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "-/../../tmp/x" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The id keys on the gateway host, so an untrusted deviceId never reaches
    // the token path at all.
    expect(result.assistantId).toBe(DEFAULT_PAIRED_ID);
    expect(
      fs.existsSync(guardianTokenPath(configDir, result.assistantId)),
    ).toBe(true);
  });

  test("a gatewayUrl with no host falls back to a random path-safe id", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: "mailto:ops@example.com" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toMatch(/^paired-[A-Za-z0-9_-]{21}$/);
  });

  test("re-pairing with no name updates the entry instead of adding another", () => {
    // Every attempt mints a fresh device id, so keying the default id on it
    // would strand the previous pairing in the lockfile (and its guardian
    // token on disk) every time a user re-paired the same assistant.
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-one", token: "t1" }),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.updated).toBe(false);

    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-two", token: "t2" }),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.assistantId).toBe(first.assistantId);
    expect(second.updated).toBe(true);

    const assistants = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    // One credential on disk, holding the newest pairing's device.
    expect(fs.readdirSync(path.join(configDir, "assistants"))).toEqual([
      DEFAULT_PAIRED_ID,
    ]);
    const token = readGuardianToken(DEFAULT_PAIRED_ID);
    expect(token.accessToken).toBe("t2");
    expect(token.deviceId).toBe("dev-two");
  });

  test("two path-prefixed deployments on one host get distinct ids", () => {
    // `normalizePairingBaseUrl` keeps a deployment path prefix, so these are
    // two different assistants reached through one host. An id keyed on the
    // host alone would read the second nameless import as a re-pair of the
    // first: it would take over the entry, overwrite the guardian token, and
    // leave the user unable to reach the first assistant at all.
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com/assistant-1",
        deviceId: "dev-one",
        token: "t1",
      }),
    });
    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com/assistant-2",
        deviceId: "dev-two",
        token: "t2",
      }),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.assistantId).toBe("paired-gw-example-com-assistant-1");
    expect(second.assistantId).toBe("paired-gw-example-com-assistant-2");
    // Neither import read as a re-pair of the other.
    expect(first.updated).toBe(false);
    expect(second.updated).toBe(false);

    // Both pairings survive: two entries, two guardian tokens, each still
    // holding its own credential and address.
    const assistants = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(2);
    expect(assistants.map((a) => a.runtimeUrl)).toEqual([
      "https://gw.example.com/assistant-1",
      "https://gw.example.com/assistant-2",
    ]);
    expect(readGuardianToken(first.assistantId).accessToken).toBe("t1");
    expect(readGuardianToken(second.assistantId).accessToken).toBe("t2");
    expect(readGuardianToken(first.assistantId).deviceId).toBe("dev-one");
    // The display names distinguish them too, or the chooser would show one
    // entry twice under the same label.
    expect(assistants.map((a) => a.name)).toEqual([
      "paired (gw.example.com/assistant-1)",
      "paired (gw.example.com/assistant-2)",
    ]);
  });

  test("re-pairing a path-prefixed deployment still updates in place", () => {
    // The prefix is part of the identity, not a nonce: the same address twice
    // is the same assistant, so the second import updates rather than adds.
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com/assistant-1",
        deviceId: "dev-one",
        token: "t1",
      }),
    });
    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        gatewayUrl: "https://gw.example.com/assistant-1",
        deviceId: "dev-two",
        token: "t2",
      }),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.assistantId).toBe(first.assistantId);
    expect(second.updated).toBe(true);
    expect(readLockfileFromDisk().assistants).toHaveLength(1);
    expect(readGuardianToken(first.assistantId).accessToken).toBe("t2");
  });

  test("a trailing slash names the same deployment as no path at all", () => {
    const bare = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: "https://gw.example.com" }),
    });
    const slashed = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: "https://gw.example.com/" }),
    });

    expect(bare.ok).toBe(true);
    expect(slashed.ok).toBe(true);
    if (!bare.ok || !slashed.ok) {
      return;
    }
    expect(bare.assistantId).toBe("paired-gw-example-com");
    expect(slashed.assistantId).toBe(bare.assistantId);
    expect(slashed.updated).toBe(true);
  });

  test("a --name still wins over the gateway-derived default", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "Desk",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assistantId).toBe("desk");
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

  test("re-importing under the same name updates it in place, address and all", () => {
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-re", token: "t1" }),
      name: "desk",
    });
    expect(first.ok).toBe(true);

    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        deviceId: "dev-re",
        token: "t2",
        gatewayUrl: "https://new.example.com",
      }),
      name: "desk",
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
    expect(readGuardianToken("desk").accessToken).toBe("t2");
  });

  test("re-pairing to a new gateway drops a cached platformAssistantId", () => {
    const first = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ deviceId: "dev-re", token: "t1" }),
      name: "desk",
    });
    expect(first.ok).toBe(true);
    const cached = readLockfileFromDisk();
    (
      cached.assistants as Array<Record<string, unknown>>
    )[0]!.platformAssistantId = "11111111-1111-4111-8111-111111111111";
    fs.writeFileSync(lockfilePath, JSON.stringify(cached, null, 2));

    const second = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({
        deviceId: "dev-re",
        token: "t2",
        gatewayUrl: "https://new.example.com",
      }),
      name: "desk",
    });

    expect(second.ok).toBe(true);
    const assistants = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.runtimeUrl).toBe("https://new.example.com");
    expect(assistants[0]!).not.toHaveProperty("platformAssistantId");
  });

  test("deletes the just-written token when the lockfile write fails", () => {
    // A lockfile path whose parent is a regular file makes the write fail
    // deterministically (unlike chmod, which root ignores) after the token
    // has already been written.
    const notADir = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(notADir, "");
    const tokenPath = guardianTokenPath(configDir, DEFAULT_PAIRED_ID);

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
    const tokenPath = guardianTokenPath(configDir, DEFAULT_PAIRED_ID);
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

describe("checkPairedAssistantName", () => {
  test("mirrors pairAssistant's refusal for a colliding name", () => {
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

    // Same derivation as the real check: the raw name is slugified first.
    const refusal = checkPairedAssistantName([lockfilePath], "Desk");
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(409);
    expect(refusal!.assistantId).toBe("desk");

    const real = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "Desk",
    });
    expect(real.ok).toBe(false);
    if (real.ok) {
      return;
    }
    expect(real.status).toBe(refusal!.status);
    expect(real.error).toBe(refusal!.error);
  });

  test("a name with no alphanumerics is refused with a 400", () => {
    const refusal = checkPairedAssistantName([lockfilePath], "///");
    expect(refusal?.status).toBe(400);
  });

  test("a free name and an existing paired entry both pass", () => {
    expect(checkPairedAssistantName([lockfilePath], "fresh")).toBeNull();

    const imported = pairAssistant([lockfilePath], configDir, {
      credentials: credentials(),
      name: "fresh",
    });
    expect(imported.ok).toBe(true);
    // A re-import updates in place, so the name is still usable.
    expect(checkPairedAssistantName([lockfilePath], "fresh")).toBeNull();
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
        signal: expect.any(AbortSignal) as unknown as AbortSignal,
      },
    ]);
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.intervalSeconds).toBe(3);
    expect(JSON.stringify(started)).not.toContain("device-code-abc");
  });

  test("clamps the poll cadence a challenge names", async () => {
    // The address is user-pasted, so the assistant answering it is untrusted:
    // a caller turns this straight into a wait, and an unbounded one either
    // parks the attempt forever or overflows a timer and spins.
    const cadences: Array<[string, number]> = [
      ["1e400", 5],
      ["-1e400", 5],
      ["null", 5],
      ["0", 5],
      ["86400", 60],
      // A sub-second cadence is floored: a caller turns this straight into a
      // wait, and an assistant naming one would have it poll as fast as the
      // round trip allows for the code's whole TTL.
      ["0.01", 1],
      ["1e-9", 1],
      ["3", 3],
    ];
    for (const [literal, expected] of cadences) {
      respond = () =>
        rawJson(
          200,
          `{"deviceCode":"device-code-abc","userCode":"ABCD-EFGH",` +
            `"expiresAt":"${new Date(Date.now() + 600_000).toISOString()}",` +
            `"intervalSeconds":${literal}}`,
        );

      const started = await pairingStart("https://gw.example.com");

      expect(started.ok).toBe(true);
      if (!started.ok) {
        continue;
      }
      expect(started.intervalSeconds).toBe(expected);
    }
  });

  test("bounds the session by the code TTL, not by the instant the assistant reports", async () => {
    respond = () =>
      json(
        200,
        challengeBody({
          expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        }),
      );

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    // A remote naming a further instant cannot buy itself a longer session.
    expect(new Date(started.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 10 * 60_000,
    );
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());
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

  test("a refused challenge is retryable and carries the status", async () => {
    respond = () => json(429, { error: { code: "RATE_LIMITED" } });

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    // Nothing was minted, so the same address is worth another attempt.
    expect(started.reason).toBe("gateway-retryable");
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
      // The reserved `.localhost` namespace resolves to loopback, and a
      // trailing DNS root dot names the same host.
      ["https://foo.localhost", "loopback"],
      ["https://localhost.", "loopback"],
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

describe("loopback refusals agree across the pairing path", () => {
  // One predicate backs both entry points, so an address class can never be
  // refused by the one the user pasted into and accepted by the one an import
  // goes through.
  test.each([
    ["https://localhost", "bare localhost"],
    ["https://foo.localhost", "reserved .localhost namespace"],
    ["https://a.b.localhost.", "absolute .localhost namespace"],
    ["https://localhost.", "absolute localhost name"],
    ["https://127.0.0.1.", "absolute IPv4 loopback literal"],
    ["https://[::1]", "IPv6 loopback"],
    ["https://0.0.0.0", "IPv4 wildcard bind"],
  ])("refuses %s (%s) at both entry points", async (address) => {
    const started = await pairingStart(address);
    expect(started.ok).toBe(false);
    if (started.ok) {
      return;
    }
    expect(started.reason).toBe("invalid-address");
    expect(started.rejection).toBe("loopback");

    const imported = pairAssistant([lockfilePath], configDir, {
      credentials: credentials({ gatewayUrl: address }),
    });
    expect(imported.ok).toBe(false);
    if (imported.ok) {
      return;
    }
    expect(imported.status).toBe(422);
    expect(imported.error).toContain("non-loopback");
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

  test("a 202 may shorten the deadline but never extend it", async () => {
    const started = await pairingStart(
      "https://gw.example.com/assistant/pair#device_code=device-code-abc",
    );
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const openedAtMs = new Date(started.expiresAt).getTime();

    // A remote that keeps naming a fresh expiry would otherwise hold the
    // session open on its own TTL rather than the code's.
    respond = () =>
      json(
        202,
        pendingBody({
          expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        }),
      );
    const extended = await pairingPoll([lockfilePath], configDir, {
      handle: started.handle,
    });
    expect(extended.ok).toBe(true);
    if (!extended.ok || extended.status !== "pending") {
      return;
    }
    expect(new Date(extended.expiresAt).getTime()).toBe(openedAtMs);

    // Shortening is the gateway's to do: the code may be revoked early.
    const sooner = new Date(Date.now() + 30_000).toISOString();
    respond = () => json(202, pendingBody({ expiresAt: sooner }));
    const shortened = await pairingPoll([lockfilePath], configDir, {
      handle: started.handle,
    });
    expect(shortened.ok).toBe(true);
    if (!shortened.ok || shortened.status !== "pending") {
      return;
    }
    expect(shortened.expiresAt).toBe(sooner);
  });

  test("clamps the poll cadence a pending reply names", async () => {
    for (const [literal, expected] of [
      ["1e400", 5],
      ["86400", 60],
      // Floored, for the same reason a challenge's cadence is.
      ["0.01", 1],
      ["7", 7],
    ] as Array<[string, number]>) {
      respond = () =>
        rawJson(
          202,
          `{"status":"pending",` +
            `"expiresAt":"${new Date(Date.now() + 300_000).toISOString()}",` +
            `"intervalSeconds":${literal}}`,
        );
      const handle = await startFromLink();

      const pending = await pairingPoll([lockfilePath], configDir, { handle });

      expect(pending.ok).toBe(true);
      if (!pending.ok || pending.status !== "pending") {
        continue;
      }
      expect(pending.intervalSeconds).toBe(expected);
    }
  });

  test("a colliding name is refused before the one-time code is spent", async () => {
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

    const refused = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "desk",
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    // The pre-check reason, not the post-exchange one: it is what tells a
    // caller holding the handle that the session is still worth keeping.
    expect(refused.reason).toBe("import-precheck");
    expect(pairingSessionSurvives(refused.reason)).toBe(true);
    expect(refused.status).toBe(409);
    // The exchange never went out, so the code is still exchangeable and the
    // user does not need a fresh pairing link.
    expect(fetchCalls).toHaveLength(0);

    // The very same session completes once the caller picks a free name.
    const imported = await pairingPoll([lockfilePath], configDir, {
      handle,
      name: "spare",
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok || imported.status !== "imported") {
      return;
    }
    expect(imported.assistantId).toBe("spare");
    expect(fetchCalls).toHaveLength(1);
  });

  test("re-pairing the same assistant with no name updates its entry", async () => {
    // Each attempt mints its own device id, so a default id keyed on that
    // would register a second entry (and a second guardian token) for the
    // assistant the user was told to re-pair.
    respond = () => json(200, approvedBody({ accessToken: "acc-1" }));
    const first = await pairingPoll([lockfilePath], configDir, {
      handle: await startFromLink(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.status !== "imported") {
      return;
    }
    expect(first.updated).toBe(false);

    respond = () => json(200, approvedBody({ accessToken: "acc-2" }));
    const second = await pairingPoll([lockfilePath], configDir, {
      handle: await startFromLink(),
    });

    expect(second.ok).toBe(true);
    if (!second.ok || second.status !== "imported") {
      return;
    }
    expect(second.assistantId).toBe(first.assistantId);
    expect(second.updated).toBe(true);
    expect(readLockfileFromDisk().assistants).toHaveLength(1);
    expect(fs.readdirSync(path.join(configDir, "assistants"))).toEqual([
      first.assistantId,
    ]);
    expect(readGuardianToken(first.assistantId).accessToken).toBe("acc-2");
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

  test("a repairable gateway refusal stays retryable and pollable", async () => {
    respond = () => json(503, { error: { code: "GUARDIAN_REPAIR_REQUIRED" } });
    const handle = await startFromLink();

    const refused = await pairingPoll([lockfilePath], configDir, { handle });

    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    // The gateway releases the challenge on a repairable failure, so this is
    // the retryable class rather than a settled rejection.
    expect(refused.reason).toBe("gateway-retryable");
    expect(refused.status).toBe(502);
    expect(refused.error).toContain("503");
    expect(fs.existsSync(lockfilePath)).toBe(false);

    // The same session exchanges the still-live code once the gateway is
    // repaired; the user never has to mint and approve another one.
    respond = () => json(200, approvedBody());
    const imported = await pairingPoll([lockfilePath], configDir, { handle });
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      return;
    }
    expect(imported.status).toBe("imported");
    expect(fetchCalls).toHaveLength(2);
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

  test("a local write that fails after the exchange surfaces as an import failure", async () => {
    // A lockfile path whose parent is a regular file makes the write fail
    // after the code has already been spent. That is the `import` reason: the
    // session is gone and a retry needs a fresh code, which is exactly what
    // the pre-check reason does NOT mean.
    const notADir = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(notADir, "");
    respond = () => json(200, approvedBody());
    const handle = await startFromLink();

    const result = await pairingPoll(
      [path.join(notADir, "lockfile.json")],
      configDir,
      { handle },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("import");
    expect(pairingSessionSurvives(result.reason)).toBe(false);
    // The exchange did go out, so the code is spent and the session is gone.
    expect(fetchCalls).toHaveLength(1);
    const again = await pairingPoll([lockfilePath], configDir, { handle });
    expect(again.ok).toBe(false);
    if (again.ok) {
      return;
    }
    expect(again.reason).toBe("unknown-session");
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

  /**
   * Hold the token exchange open until the returned release runs, so a cancel
   * can land in the same window a dismissed dialog's cancel lands in.
   */
  const heldApproval = (): (() => void) => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = async () => {
      await held;
      return json(200, approvedBody());
    };
    return () => release();
  };

  const startLinkSession = async (): Promise<string> => {
    const started = await pairingStart(
      "https://gw.example.com/assistant/pair#device_code=device-code-abc",
    );
    if (!started.ok) {
      throw new Error(`unexpected start failure: ${started.error}`);
    }
    return started.handle;
  };

  test("a cancel while the exchange is in flight persists nothing", async () => {
    const approve = heldApproval();
    const handle = await startLinkSession();
    const polled = pairingPoll([lockfilePath], configDir, { handle });
    await requestsInFlight(1);

    expect(pairingCancel(handle)).toBe(true);
    // The gateway approves anyway, after the caller walked away.
    approve();
    const result = await polled;

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unknown-session");
    expect(result.status).toBe(404);
    // No lockfile entry and no guardian token for a pairing the user dropped.
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(fs.existsSync(path.join(configDir, "assistants"))).toBe(false);
  });

  test("an aborted exchange is a dead session, not a retryable transport failure", async () => {
    respond = (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const handle = await startLinkSession();
    const polled = pairingPoll([lockfilePath], configDir, { handle });
    await requestsInFlight(1);

    expect(pairingCancel(handle)).toBe(true);
    const result = await polled;

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // `unreachable` is the retryable class, so a session the caller killed
    // must never be reported as one.
    expect(result.reason).toBe("unknown-session");
    expect(fetchCalls[0]!.signal?.aborted).toBe(true);
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(fs.existsSync(path.join(configDir, "assistants"))).toBe(false);
  });

  test("an exchange nobody cancels still imports", async () => {
    const approve = heldApproval();
    const handle = await startLinkSession();
    const polled = pairingPoll([lockfilePath], configDir, { handle });
    await requestsInFlight(1);

    approve();
    const result = await polled;

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe("imported");
    const entry = (
      readLockfileFromDisk().assistants as Array<Record<string, unknown>>
    )[0]!;
    expect(entry).toMatchObject({ cloud: "paired", paired: true });
    expect(readGuardianToken(entry.assistantId as string).accessToken).toBe(
      "acc-tok",
    );
  });

  test("a non-string handle is refused rather than throwing", () => {
    expect(pairingCancel(undefined)).toBe(false);
    expect(pairingCancel(7)).toBe(false);
  });

  test("a session the expiry sweep evicts mid-exchange persists nothing", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = async (call) => {
      if (call.url.includes("pairing-challenge")) {
        return json(
          200,
          challengeBody({
            expiresAt: new Date(Date.now() + 200).toISOString(),
          }),
        );
      }
      await held;
      return json(200, approvedBody());
    };
    const started = await pairingStart("https://gw.example.com");
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const polled = pairingPoll([lockfilePath], configDir, {
      handle: started.handle,
    });
    await requestsInFlight(2);
    // The challenge's TTL runs out with the exchange still open, then any
    // pairing entry point sweeps the session out of the map.
    await sleep(300);
    expect(pairingCancel("no-such-handle")).toBe(false);

    // The gateway approves after the sweep, for a session nobody holds.
    release();
    const result = await polled;

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unknown-session");
    expect(result.status).toBe(404);
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(fs.existsSync(path.join(configDir, "assistants"))).toBe(false);
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

  test("a nameless re-import adopts the entry the previous release keyed", () => {
    // The previous release keyed a nameless bundle import on the bundle's own
    // device id. Re-importing that bundle updates that entry rather than
    // registering a second one under the gateway-derived id.
    const bundle = encodeBundle({
      gatewayUrl: "https://gw.example.com",
      token: "tok-1",
      deviceId: "dev-legacy",
    });
    writeLockfile({
      assistants: [
        {
          assistantId: "paired-dev-legacy",
          cloud: "paired",
          paired: true,
          runtimeUrl: "https://gw.example.com",
        },
      ],
    });

    const result = connectImport([lockfilePath], configDir, { bundle });

    expect(result).toMatchObject({
      ok: true,
      assistantId: "paired-dev-legacy",
      updated: true,
    });
    const entries = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(1);
    expect(
      fs.existsSync(guardianTokenPath(configDir, "paired-dev-legacy")),
    ).toBe(true);
  });

  test("a legacy id naming another gateway is not adopted", () => {
    // The device id is untrusted bundle input, so an entry that does not name
    // the same gateway is left alone rather than repointed at another host.
    writeLockfile({
      assistants: [
        {
          assistantId: "paired-dev-legacy",
          cloud: "paired",
          paired: true,
          runtimeUrl: "https://other.example.com",
        },
      ],
    });

    const result = connectImport([lockfilePath], configDir, {
      bundle: encodeBundle({
        gatewayUrl: "https://gw.example.com",
        token: "tok-1",
        deviceId: "dev-legacy",
      }),
    });

    expect(result).toMatchObject({ ok: true, updated: false });
    const entries = readLockfileFromDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(2);
    expect(
      (entries.find((e) => e.assistantId === "paired-dev-legacy") ?? {})
        .runtimeUrl,
    ).toBe("https://other.example.com");
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
      assistantId: "paired-gw-example-com",
      updated: false,
      accessOnly: true,
    });
  });
});
