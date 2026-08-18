import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardianTokenPath } from "../config";
import { unpairAssistant } from "../unpair";

let tmpDir: string;
let lockfilePath: string;
let configDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-unpair-"));
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

const seedGuardianToken = (assistantId: string): string => {
  const tokenPath = guardianTokenPath(configDir, assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: "tok" }));
  return tokenPath;
};

describe("unpairAssistant", () => {
  test("removes the paired entry, deletes its guardian token, and reassigns the active pointer", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", cloud: "paired", runtimeUrl: "https://h" },
        { assistantId: "local-1", cloud: "local", futureField: "keep-me" },
      ],
      activeAssistant: "paired-1",
    });
    const tokenPath = seedGuardianToken("paired-1");

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Active falls back to the first remaining entry, matching the CLI's
    // removeAssistantEntry semantics.
    expect(result.lockfile.activeAssistant).toBe("local-1");
    expect(result.lockfile.assistants.map((a) => a.assistantId)).toEqual([
      "local-1",
    ]);
    expect(fs.existsSync(tokenPath)).toBe(false);

    // Unknown fields on the remaining entries survive the rewrite.
    const onDisk = readLockfileFromDisk();
    expect(onDisk.assistants).toEqual([
      { assistantId: "local-1", cloud: "local", futureField: "keep-me" },
    ]);
    expect(onDisk.activeAssistant).toBe("local-1");
  });

  test("removing the sole (active) entry leaves no active pointer", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBeNull();
    expect(result.lockfile.assistants).toEqual([]);
  });

  test("reassigns the active pointer past tolerated malformed entries", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", cloud: "paired" },
        { notAnAssistant: true },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBe("local-1");
  });

  test("a failed token delete aborts before touching the lockfile", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: "paired-1",
    });
    // A non-empty directory at the token path makes rmSync (non-recursive)
    // throw, standing in for EPERM-style failures.
    const tokenPath = guardianTokenPath(configDir, "paired-1");
    fs.mkdirSync(path.join(tokenPath, "oops"), { recursive: true });

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(500);
    expect(result.error).toContain("guardian token");
    // The entry is untouched, so the unpair can be retried.
    expect(readLockfileFromDisk().assistants).toEqual([
      { assistantId: "paired-1", cloud: "paired" },
    ]);
    expect(readLockfileFromDisk().activeAssistant).toBe("paired-1");
  });

  test("restores the guardian token when the lockfile write fails", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: null,
    });
    const tokenPath = seedGuardianToken("paired-1");
    // A read-only lockfile directory makes the tmp-file write fail after the
    // token has already been deleted.
    fs.chmodSync(tmpDir, 0o500);
    try {
      const result = unpairAssistant([lockfilePath], configDir, "paired-1");

      expect(result.ok).toBe(false);
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(fs.readFileSync(tokenPath, "utf-8")).toBe(
        JSON.stringify({ accessToken: "tok" }),
      );
    } finally {
      fs.chmodSync(tmpDir, 0o700);
    }
  });

  test("leaves the active pointer alone when it names another assistant", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", cloud: "paired" },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "local-1",
    });

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBe("local-1");
  });

  test("succeeds when the guardian token file is already gone", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: null,
    });

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
  });

  test("refuses an unknown assistant without touching disk", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant([lockfilePath], configDir, "nope");

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "No such assistant",
    });
    expect(readLockfileFromDisk().activeAssistant).toBe("paired-1");
  });

  test("refuses a non-paired assistant and leaves its entry and token alone", () => {
    writeLockfile({
      assistants: [{ assistantId: "local-1", cloud: "local" }],
      activeAssistant: "local-1",
    });
    const tokenPath = seedGuardianToken("local-1");

    const result = unpairAssistant([lockfilePath], configDir, "local-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(400);
    expect(result.error).toContain("paired");
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(readLockfileFromDisk().assistants).toEqual([
      { assistantId: "local-1", cloud: "local" },
    ]);
  });

  test("refuses a cloudless entry (defaults to local) rather than treating it as paired", () => {
    writeLockfile({
      assistants: [{ assistantId: "bare-1" }],
      activeAssistant: null,
    });

    const result = unpairAssistant([lockfilePath], configDir, "bare-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(400);
  });

  test("refuses with 423 under a held write lock, leaving entry and token alone", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: "paired-1",
    });
    const tokenPath = seedGuardianToken("paired-1");
    fs.mkdirSync(`${lockfilePath}.lock`);
    try {
      const result = unpairAssistant([lockfilePath], configDir, "paired-1");

      expect(result).toMatchObject({ ok: false, status: 423 });
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(readLockfileFromDisk().assistants).toEqual([
        { assistantId: "paired-1", cloud: "paired" },
      ]);
    } finally {
      fs.rmdirSync(`${lockfilePath}.lock`);
    }
  });

  test("a successful unpair leaves no lock dir behind", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", cloud: "paired" }],
      activeAssistant: "paired-1",
    });
    seedGuardianToken("paired-1");

    const result = unpairAssistant([lockfilePath], configDir, "paired-1");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(`${lockfilePath}.lock`)).toBe(false);
  });
});
