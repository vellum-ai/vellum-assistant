import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getGuardianAccessToken,
  formatGuardianRefreshCliFailure,
  parseGuardianRefreshCliFailure,
  PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
  PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
  isConfidentialRefreshUrl,
  isLoopbackUrl,
  saveGuardianToken,
  type GuardianTokenData,
} from "../guardian-token";
import type { CliInvocation } from "../util";

// An invocation that would fail loudly if any tested branch spawned the CLI.
const invocation: CliInvocation = { command: "false", baseArgs: [] };

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeTokenData(over: Partial<GuardianTokenData>): GuardianTokenData {
  return {
    guardianPrincipalId: "principal",
    accessToken: "access",
    accessTokenExpiresAt: FUTURE,
    refreshToken: "refresh",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: FUTURE,
    isNew: false,
    deviceId: "device",
    leasedAt: new Date().toISOString(),
    ...over,
  };
}

describe("getGuardianAccessToken", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-token-test-"));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("returns the stored token while the access token is fresh", async () => {
    saveGuardianToken(configDir, "asst-1", makeTokenData({}));

    expect(
      await getGuardianAccessToken("asst-1", configDir, invocation, true),
    ).toEqual({ ok: true, accessToken: "access" });
  });

  test("returns a structured 404 when no token file exists", async () => {
    expect(
      await getGuardianAccessToken("missing", configDir, invocation, true),
    ).toEqual({ ok: false, status: 404, error: "Guardian token not found" });
  });

  test("expired refresh token yields hatch/wake guidance by default", async () => {
    saveGuardianToken(
      configDir,
      "asst-1",
      makeTokenData({ accessTokenExpiresAt: PAST, refreshTokenExpiresAt: PAST }),
    );

    const result = await getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Guardian token expired. Re-run `vellum hatch` or `vellum wake`.",
    });
  });

  test("expired refresh token yields re-pair guidance for a paired entry", async () => {
    saveGuardianToken(
      configDir,
      "asst-1",
      makeTokenData({ accessTokenExpiresAt: PAST, refreshTokenExpiresAt: PAST }),
    );

    const result = await getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
      undefined,
      {
        paired: true,
        pairedGatewayUrl: "https://gateway.example.com",
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      error:
        "Guardian token expired. Run `vellum pair` on the assistant's machine, then re-import it from the app's connect flow or with `vellum connect import`.",
    });
  });

  test("an explicit paired: false keeps the hatch/wake guidance", async () => {
    saveGuardianToken(
      configDir,
      "asst-1",
      makeTokenData({ accessTokenExpiresAt: PAST, refreshTokenExpiresAt: PAST }),
    );

    const result = await getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
      undefined,
      { paired: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("vellum hatch");
  });

  test("returns a paired token only for its stored gateway target", async () => {
    saveGuardianToken(
      configDir,
      "paired-1",
      makeTokenData({ pairedGatewayUrl: "https://gateway.example.com" }),
    );

    expect(
      await getGuardianAccessToken("paired-1", configDir, invocation, true),
    ).toEqual({
      ok: false,
      status: 403,
      error: PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
    });
    expect(
      await getGuardianAccessToken(
        "paired-1",
        configDir,
        invocation,
        true,
        undefined,
        {
          paired: true,
          pairedGatewayUrl: "https://attacker.example.com",
        },
      ),
    ).toEqual({
      ok: false,
      status: 403,
      error: PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
    });
    expect(
      await getGuardianAccessToken(
        "paired-1",
        configDir,
        invocation,
        true,
        undefined,
        {
          paired: true,
          pairedGatewayUrl: "https://gateway.example.com",
        },
      ),
    ).toEqual({ ok: true, accessToken: "access" });
  });

  test("binds a legacy paired token before returning it", async () => {
    saveGuardianToken(configDir, "paired-1", makeTokenData({}));

    expect(
      await getGuardianAccessToken(
        "paired-1",
        configDir,
        invocation,
        true,
        undefined,
        {
          paired: true,
          pairedGatewayUrl: "https://gateway.example.com",
        },
      ),
    ).toEqual({ ok: true, accessToken: "access" });

    const stored = JSON.parse(
      fs.readFileSync(
        path.join(configDir, "assistants", "paired-1", "guardian-token.json"),
        "utf-8",
      ),
    ) as GuardianTokenData;
    expect(stored.pairedGatewayUrl).toBe("https://gateway.example.com");
  });
});

describe("parseGuardianRefreshCliFailure", () => {
  test("reads a labeled 401 from stderr", () => {
    expect(
      parseGuardianRefreshCliFailure(
        "",
        `Failed to refresh guardian token.\n${formatGuardianRefreshCliFailure(401, "Failed to refresh guardian token")}\n`,
      ),
    ).toEqual({
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    });
  });

  test("reads a labeled 503 from stderr", () => {
    expect(
      parseGuardianRefreshCliFailure(
        "",
        formatGuardianRefreshCliFailure(503, "Assistant gateway is unreachable"),
      ),
    ).toEqual({
      ok: false,
      status: 503,
      error: "Assistant gateway is unreachable",
    });
  });

  test("an unlabeled non-zero CLI exit is a 503, not a 401", () => {
    expect(
      parseGuardianRefreshCliFailure("", "Failed to refresh guardian token."),
    ).toEqual({
      ok: false,
      status: 503,
      error: "Failed to refresh guardian token",
    });
  });
});

describe("isConfidentialRefreshUrl", () => {
  test.each([
    ["https://gw.example.com", "https reaches it encrypted"],
    ["http://localhost:7830", "exact localhost stays on this machine"],
    ["http://127.0.0.5:7830", "127/8 stays on this machine"],
    ["http://[::1]:7830", "IPv6 loopback stays on this machine"],
    ["http://localhost.:7830", "an absolute localhost name is the same host"],
    ["http://0.0.0.0:7830", "a wildcard bind dials a local listener"],
  ])("%s is confidential (%s)", (url) => {
    expect(isConfidentialRefreshUrl(url)).toBe(true);
  });

  test.each([
    ["http://gw.example.com", "plaintext to a public host"],
    ["http://10.0.0.5:7830", "plaintext to a private address"],
    ["not a url", "an unparseable value"],
  ])("%s is not confidential (%s)", (url) => {
    expect(isConfidentialRefreshUrl(url)).toBe(false);
  });

  test("a reserved .localhost name is refused plaintext", () => {
    // RFC 6761 says a resolver should map the whole `.localhost` namespace to
    // loopback; glibc does not by default, so this name can answer with any
    // address. Treating it as confidential would put a long-lived, replayable
    // refresh token on the wire in plaintext to whatever answered.
    for (const url of [
      "http://evil.localhost:8080",
      "http://evil.localhost.:8080",
      "http://a.b.localhost",
    ]) {
      expect(isConfidentialRefreshUrl(url)).toBe(false);
      // The pairing side still refuses it as loopback: a name that might be
      // local is refused by the guards that refuse loopback and denied by the
      // guards that reward it.
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  test("https to a .localhost name is confidential on the protocol alone", () => {
    expect(isConfidentialRefreshUrl("https://evil.localhost:8443")).toBe(true);
  });
});
