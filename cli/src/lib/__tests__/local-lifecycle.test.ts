import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AssistantEntry } from "../assistant-config.js";
import {
  ACTIVE_CALL_LEASES_FILE,
  getAssistantRootDir,
  readActiveCallLeases,
  sleepLocalAssistant,
} from "../local-lifecycle.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "local-lifecycle-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeEntry(instanceDir: string): AssistantEntry {
  return {
    assistantId: "test-assistant",
    runtimeUrl: "http://127.0.0.1:7830",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7831,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 7832,
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readActiveCallLeases", () => {
  test("returns leases from a valid v1 file", () => {
    const vellumDir = makeTempDir();
    writeFileSync(
      join(vellumDir, ACTIVE_CALL_LEASES_FILE),
      JSON.stringify({
        version: 1,
        leases: [{ callSessionId: "call-1" }, { callSessionId: "call-2" }],
      }),
    );

    expect(readActiveCallLeases(vellumDir)).toEqual([
      { callSessionId: "call-1" },
      { callSessionId: "call-2" },
    ]);
  });

  test("throws when version is not 1", () => {
    const vellumDir = makeTempDir();
    writeFileSync(
      join(vellumDir, ACTIVE_CALL_LEASES_FILE),
      JSON.stringify({ version: 2, leases: [] }),
    );

    expect(() => readActiveCallLeases(vellumDir)).toThrow(
      /Invalid active call lease file/,
    );
  });

  test("throws when leases is not an array", () => {
    const vellumDir = makeTempDir();
    writeFileSync(
      join(vellumDir, ACTIVE_CALL_LEASES_FILE),
      JSON.stringify({ version: 1, leases: {} }),
    );

    expect(() => readActiveCallLeases(vellumDir)).toThrow(
      /Invalid active call lease file/,
    );
  });

  test("returns [] when the file is absent", () => {
    const vellumDir = makeTempDir();
    expect(readActiveCallLeases(vellumDir)).toEqual([]);
  });

  test("filters entries without a string callSessionId", () => {
    const vellumDir = makeTempDir();
    writeFileSync(
      join(vellumDir, ACTIVE_CALL_LEASES_FILE),
      JSON.stringify({
        version: 1,
        leases: [
          { callSessionId: "call-1" },
          { callSessionId: 42 },
          {},
          { callSessionId: "" },
        ],
      }),
    );

    expect(readActiveCallLeases(vellumDir)).toEqual([
      { callSessionId: "call-1" },
    ]);
  });
});

describe("getAssistantRootDir", () => {
  test("throws the re-hatch error when entry.resources is missing", () => {
    const entry: AssistantEntry = {
      assistantId: "no-resources",
      runtimeUrl: "http://127.0.0.1:7830",
      cloud: "local",
    };

    expect(() => getAssistantRootDir(entry)).toThrow(
      "Local assistant 'no-resources' is missing resource configuration. Re-hatch to fix.",
    );
  });
});

describe("sleepLocalAssistant", () => {
  test("rejects when an active call lease blocks the sleep and leaves pid files untouched", async () => {
    const instanceDir = makeTempDir();
    const vellumDir = join(instanceDir, ".vellum");
    const workspaceDir = join(vellumDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    // Use this test process's pid so isProcessAlive reports the daemon alive.
    const daemonPidFile = join(workspaceDir, "vellum.pid");
    writeFileSync(daemonPidFile, String(process.pid));
    const gatewayPidFile = join(vellumDir, "gateway.pid");
    writeFileSync(gatewayPidFile, String(process.pid));
    writeFileSync(
      join(vellumDir, ACTIVE_CALL_LEASES_FILE),
      JSON.stringify({ version: 1, leases: [{ callSessionId: "call-1" }] }),
    );

    const entry = makeEntry(instanceDir);
    await expect(sleepLocalAssistant(entry, { force: false })).rejects.toThrow(
      "assistant is staying awake for active phone calls (call-1). Use 'vellum sleep --force' to stop it anyway.",
    );

    expect(readFileSync(daemonPidFile, "utf-8")).toBe(String(process.pid));
    expect(readFileSync(gatewayPidFile, "utf-8")).toBe(String(process.pid));
  });

  test("resolves with force: true when no processes are running", async () => {
    const instanceDir = makeTempDir();
    mkdirSync(join(instanceDir, ".vellum", "workspace"), { recursive: true });

    const entry = makeEntry(instanceDir);
    await expect(
      sleepLocalAssistant(entry, { force: true }),
    ).resolves.toBeUndefined();
    expect(existsSync(join(instanceDir, ".vellum", "gateway.pid"))).toBe(false);
  });
});
