import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CliInvocation } from "../util";
import type { GuardianTokenData } from "../guardian-token";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnMock = mock((_command: string, _args: string[]) => {
  lastChild = new FakeChild();
  return lastChild;
});

mock.module("node:child_process", () => ({ spawn: spawnMock }));

let getGuardianAccessToken: typeof import("../guardian-token").getGuardianAccessToken;
let saveGuardianToken: typeof import("../guardian-token").saveGuardianToken;
let formatGuardianRefreshCliFailure: typeof import("../guardian-token").formatGuardianRefreshCliFailure;

beforeAll(async () => {
  ({
    getGuardianAccessToken,
    saveGuardianToken,
    formatGuardianRefreshCliFailure,
  } = await import("../guardian-token"));
});

afterEach(() => {
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeTokenData(over: Partial<GuardianTokenData>): GuardianTokenData {
  return {
    guardianPrincipalId: "principal",
    accessToken: "access",
    accessTokenExpiresAt: PAST,
    refreshToken: "refresh",
    refreshTokenExpiresAt: FUTURE,
    refreshAfter: FUTURE,
    isNew: false,
    deviceId: "device",
    leasedAt: new Date().toISOString(),
    ...over,
  };
}

describe("getGuardianAccessToken refresh spawn", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-refresh-"));
    saveGuardianToken(configDir, "asst-1", makeTokenData({}));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("a labeled CLI 503 is an unreachable gateway, not a spent token", async () => {
    const pending = getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
    );
    await tick();
    lastChild.stderr.emit(
      "data",
      Buffer.from(
        `${formatGuardianRefreshCliFailure(503, "Assistant gateway is unreachable")}\n`,
      ),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 503,
      error: "Assistant gateway is unreachable",
    });
  });

  test("a labeled CLI 401 is a spent credential", async () => {
    const pending = getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
    );
    await tick();
    lastChild.stderr.emit(
      "data",
      Buffer.from(
        `${formatGuardianRefreshCliFailure(401, "Failed to refresh guardian token")}\n`,
      ),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 401,
      error: "Failed to refresh guardian token",
    });
  });

  test("a labeled CLI 403 is a local confidentiality refusal, not a spent credential", async () => {
    const pending = getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
    );
    await tick();
    lastChild.stderr.emit(
      "data",
      Buffer.from(
        `${formatGuardianRefreshCliFailure(403, "Refusing to refresh the guardian token over an insecure URL")}\n`,
      ),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 403,
      error: "Refusing to refresh the guardian token over an insecure URL",
    });
  });

  test("an unlabeled non-zero CLI exit is a 503, not a 401", async () => {
    const pending = getGuardianAccessToken(
      "asst-1",
      configDir,
      invocation,
      true,
    );
    await tick();
    lastChild.stderr.emit(
      "data",
      Buffer.from("Failed to refresh guardian token.\n"),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 503,
      error: "Failed to refresh guardian token",
    });
  });
});
