/**
 * Tests for `vellum unpair <name>`: forget a paired (cloud:"paired") assistant
 * by removing its lockfile entry + guardian token. Refuses non-paired entries.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "unpair-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];

import { unpair } from "../commands/unpair.js";
import {
  findAssistantByName,
  saveAssistantEntry,
} from "../lib/assistant-config.js";
import {
  deleteGuardianToken,
  loadGuardianToken,
  saveGuardianToken,
} from "../lib/guardian-token.js";

function seedToken(assistantId: string): void {
  saveGuardianToken(assistantId, {
    guardianPrincipalId: "imported",
    accessToken: "acc",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshToken: "ref",
    refreshTokenExpiresAt: Date.now() + 3_600_000,
    refreshAfter: "",
    isNew: false,
    deviceId: "dev",
    leasedAt: new Date().toISOString(),
  });
}

/** Run unpair with console.error + process.exit spied. */
async function runUnpair(): Promise<{ exited: boolean; errors: string }> {
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit:${c}`);
  }) as never);
  let exited = false;
  try {
    await unpair();
  } catch (e) {
    exited = (e as Error).message === "exit:1";
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, errors: errors.join("\n") };
}

describe("vellum unpair", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_CONFIG_HOME = testDir;
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("removes a paired entry's lockfile entry and guardian token", async () => {
    saveAssistantEntry({
      assistantId: "px",
      name: "Paired Box",
      runtimeUrl: "http://10.0.0.9:7830",
      cloud: "paired",
      paired: true,
      species: "vellum",
    });
    seedToken("px");
    expect(findAssistantByName("px")).not.toBeNull();
    expect(loadGuardianToken("px")).not.toBeNull();

    // Non-interactive test env → use --yes to bypass the confirmation prompt.
    process.argv = ["bun", "vellum", "unpair", "px", "--yes"];
    const { exited } = await runUnpair();

    expect(exited).toBe(false);
    expect(findAssistantByName("px")).toBeNull();
    expect(loadGuardianToken("px")).toBeNull();
  });

  test("refuses to unpair without --yes in a non-interactive terminal", async () => {
    saveAssistantEntry({
      assistantId: "py",
      name: "Paired Two",
      runtimeUrl: "http://10.0.0.9:7830",
      cloud: "paired",
      paired: true,
      species: "vellum",
    });
    seedToken("py");

    process.argv = ["bun", "vellum", "unpair", "py"]; // no --yes
    const { exited, errors } = await runUnpair();

    expect(exited).toBe(true);
    expect(errors).toContain("--yes");
    // Not removed — confirmation was required.
    expect(findAssistantByName("py")).not.toBeNull();
    expect(loadGuardianToken("py")).not.toBeNull();
  });

  test("refuses a non-paired (local) assistant and leaves it intact", async () => {
    saveAssistantEntry({
      assistantId: "desk",
      name: "Desk",
      runtimeUrl: "http://127.0.0.1:7830",
      cloud: "local",
      species: "vellum",
    });

    process.argv = ["bun", "vellum", "unpair", "desk"];
    const { exited, errors } = await runUnpair();

    expect(exited).toBe(true);
    expect(errors).toContain("vellum retire");
    expect(findAssistantByName("desk")).not.toBeNull(); // untouched
  });

  test("errors on an unknown name", async () => {
    process.argv = ["bun", "vellum", "unpair", "nope"];
    const { exited } = await runUnpair();
    expect(exited).toBe(true);
  });

  test("deleteGuardianToken is a no-op when the token is absent", () => {
    // No token seeded for this id; calling (twice) must not throw.
    expect(() => deleteGuardianToken("ghost")).not.toThrow();
    expect(() => deleteGuardianToken("ghost")).not.toThrow();
  });
});
