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
