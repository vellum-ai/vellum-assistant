import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardianTokenPath } from "../config";
import {
  connectImport,
  decodePairBundle,
  MAX_PAIR_BUNDLE_LENGTH,
  pairAssistant,
  type PairBundle,
} from "../pair";

let tmpDir: string;
let lockfilePath: string;
let configDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-pair-"));
  lockfilePath = path.join(tmpDir, "lockfile.json");
  configDir = path.join(tmpDir, "config");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const readLockfileFromDisk = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as Record<string, unknown>;

const encodeBundle = (obj: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64");

const bundle = (overrides: Partial<PairBundle> = {}): PairBundle => ({
  gatewayUrl: "http://10.0.0.5:7830",
  token: "test-token",
  assistantId: "self",
  deviceId: "dev-aaa",
  ...overrides,
});

/** A syntactically valid JWT whose `exp` is 2030-01-01T00:00:00Z. */
const JWT_EXP_S = 1893456000;
const jwtWithExp = `h.${Buffer.from(JSON.stringify({ exp: JWT_EXP_S })).toString("base64")}.s`;

describe("decodePairBundle", () => {
  test("decodes a full bundle, preserving a numeric refreshTokenExpiresAt", () => {
    const result = decodePairBundle(
      encodeBundle({
        gatewayUrl: "https://tunnel.example.com",
        token: "tok",
        assistantId: "self",
        deviceId: "dev-1",
        refreshToken: "refresh",
        refreshTokenExpiresAt: 1893456000000,
        refreshAfter: "2026-07-01T00:00:00.000Z",
      }),
    );

    expect(result).toEqual({
      ok: true,
      bundle: {
        gatewayUrl: "https://tunnel.example.com",
        token: "tok",
        assistantId: "self",
        deviceId: "dev-1",
        refreshToken: "refresh",
        refreshTokenExpiresAt: 1893456000000,
        refreshAfter: "2026-07-01T00:00:00.000Z",
      },
    });
  });

  test("drops malformed optional fields instead of failing", () => {
    const result = decodePairBundle(
      encodeBundle({
        gatewayUrl: "http://10.0.0.5:7830",
        token: "tok",
        deviceId: 42,
        refreshToken: { nope: true },
        refreshAfter: 7,
      }),
    );

    expect(result).toEqual({
      ok: true,
      bundle: {
        gatewayUrl: "http://10.0.0.5:7830",
        token: "tok",
        assistantId: undefined,
        deviceId: undefined,
        refreshToken: undefined,
        refreshTokenExpiresAt: undefined,
        refreshAfter: undefined,
      },
    });
  });

  test("rejects garbage base64 and JSON non-objects without throwing", () => {
    for (const encoded of [
      "not-valid-base64!!",
      Buffer.from(JSON.stringify("just a string")).toString("base64"),
      Buffer.from("{truncated").toString("base64"),
    ]) {
      const result = decodePairBundle(encoded);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(typeof result.error).toBe("string");
    }
  });

  test("rejects a bundle missing token or gatewayUrl", () => {
    expect(decodePairBundle(encodeBundle({ token: "tok" })).ok).toBe(false);
    expect(
      decodePairBundle(encodeBundle({ gatewayUrl: "http://h" })).ok,
    ).toBe(false);
  });

  test("rejects a non-http(s) or relative gatewayUrl", () => {
    expect(
      decodePairBundle(encodeBundle({ gatewayUrl: "ftp://nope", token: "t" }))
        .ok,
    ).toBe(false);
    expect(
      decodePairBundle(encodeBundle({ gatewayUrl: "/relative", token: "t" }))
        .ok,
    ).toBe(false);
  });
});

describe("pairAssistant", () => {
  test("writes the lockfile entry and guardian token with the exact CLI shapes and modes", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      bundle: bundle({ token: jwtWithExp, deviceId: "dev-aaa" }),
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
    expect(new Date(leasedAt as string).toISOString()).toBe(
      leasedAt as string,
    );
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
      bundle: bundle({ token: "opaque-token", deviceId: "dev-exp" }),
    });
    expect(result.ok).toBe(true);

    const token = JSON.parse(
      fs.readFileSync(guardianTokenPath(configDir, "paired-dev-exp"), "utf-8"),
    ) as Record<string, unknown>;
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
      bundle: bundle({
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
    const token = JSON.parse(
      fs.readFileSync(
        guardianTokenPath(configDir, "paired-dev-refresh"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(token.refreshToken).toBe("refresh-tok");
    expect(token.refreshTokenExpiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(token.refreshAfter).toBe("2026-07-01T00:00:00.000Z");
  });

  test("refuses loopback gateway URLs so a bundle can't alias local services", () => {
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
        bundle: bundle({ gatewayUrl, deviceId: "dev-loop" }),
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.status).toBe(422);
      expect(result.error).toContain("non-loopback");
    }
    // Nothing was written for any refused bundle.
    expect(fs.existsSync(lockfilePath)).toBe(false);
    expect(
      fs.existsSync(guardianTokenPath(configDir, "paired-dev-loop")),
    ).toBe(false);
  });

  test("a non-loopback plaintext http gateway is access-only even with a refresh token", () => {
    // refreshGuardianToken refuses to send the refresh token over plaintext
    // LAN URLs, so the pairing can never renew; report it access-only so the
    // expiry warning shows.
    const result = pairAssistant([lockfilePath], configDir, {
      bundle: bundle({
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
      bundle: bundle(),
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
      bundle: bundle(),
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
      bundle: bundle({ deviceId: "-/../../tmp/x" }),
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
      bundle: bundle({ deviceId: undefined }),
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
      bundle: bundle(),
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
      bundle: bundle({ deviceId: "dev-re", token: "t1" }),
    });
    expect(first.ok).toBe(true);

    const second = pairAssistant([lockfilePath], configDir, {
      bundle: bundle({
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
    const token = JSON.parse(
      fs.readFileSync(guardianTokenPath(configDir, "paired-dev-re"), "utf-8"),
    ) as Record<string, unknown>;
    expect(token.accessToken).toBe("t2");
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
      { bundle: bundle() },
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(tokenPath)).toBe(false);
    // The per-assistant directory is cleaned up too.
    expect(fs.existsSync(path.dirname(tokenPath))).toBe(false);
  });

  test("restores the prior token when a re-import's lockfile write fails", () => {
    const first = pairAssistant([lockfilePath], configDir, {
      bundle: bundle({ deviceId: "dev-re", token: "t1" }),
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
      { bundle: bundle({ deviceId: "dev-re", token: "t2" }) },
    );

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(tokenPath, "utf-8")).toBe(priorContents);
  });

  test("an unparseable gatewayUrl on an unvalidated bundle is refused, not thrown", () => {
    const result = pairAssistant([lockfilePath], configDir, {
      bundle: bundle({ gatewayUrl: "not a url" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(422);
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
        bundle: "a".repeat(MAX_PAIR_BUNDLE_LENGTH + 1),
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
      accessOnly: true,
    });
  });
});
