import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { getWorkspacePromptPath } from "../util/platform.js";

// ── fs.readFileSync override (for read-failure test) ─────────────────
// We mock node:fs so we can inject a readFileSync that throws for the
// workspace path. All other call sites fall through to the real fs.
const realReadFileSync = readFileSync;
const realExistsSync = existsSync;

let readFileSyncOverride:
  | ((path: Parameters<typeof readFileSync>[0]) => string | undefined)
  | null = null;

mock.module("node:fs", () => ({
  existsSync: realExistsSync,
  readFileSync: ((
    path: Parameters<typeof readFileSync>[0],
    opts?: Parameters<typeof readFileSync>[1],
  ) => {
    if (readFileSyncOverride) {
      const override = readFileSyncOverride(path);
      if (override !== undefined) return override;
    }
    return realReadFileSync(path, opts);
  }) as typeof readFileSync,
}));

// ── In-memory checkpoint store ───────────────────────────────────────
const store = new Map<string, string>();
let setCheckpointCallCount = 0;

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => store.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    setCheckpointCallCount += 1;
    store.set(key, value);
  },
}));

// ── Mutable config stub ──────────────────────────────────────────────
const updatesConfig = { enabled: true };

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ updates: updatesConfig }),
}));

// ── runBackgroundJob mock ────────────────────────────────────────────
let runBackgroundJobCalls = 0;
let runBackgroundJobLastArgs: Record<string, unknown> | null = null;
let runBackgroundJobShouldThrow = false;
let runBackgroundJobOk = true;
let runBackgroundJobErrorKind:
  | "timeout"
  | "model_provider"
  | "exception"
  | undefined = undefined;
let runBackgroundJobErrorMessage: string | undefined = undefined;
// A side-effect function invoked during the job. Lets tests simulate the
// agent deleting UPDATES.md while the job is running.
let runBackgroundJobSideEffect: (() => void) | null = null;

mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: Record<string, unknown>) => {
    runBackgroundJobCalls += 1;
    runBackgroundJobLastArgs = opts;
    if (runBackgroundJobSideEffect) {
      runBackgroundJobSideEffect();
    }
    if (runBackgroundJobShouldThrow) {
      throw new Error("simulated runner failure");
    }
    if (runBackgroundJobOk) {
      return {
        conversationId: `conv-${runBackgroundJobCalls}`,
        ok: true,
      };
    }
    return {
      conversationId: `conv-${runBackgroundJobCalls}`,
      ok: false,
      error: new Error(runBackgroundJobErrorMessage ?? "simulated failure"),
      errorKind: runBackgroundJobErrorKind ?? "exception",
    };
  },
}));

const { runUpdateBulletinJobIfNeeded } =
  await import("../prompts/update-bulletin-job.js");

const HASH_CHECKPOINT_KEY = "updates:last_processed_hash";
const EMPTY_HASH = "empty";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const workspacePath = getWorkspacePromptPath("UPDATES.md");

describe("runUpdateBulletinJobIfNeeded", () => {
  beforeEach(() => {
    store.clear();
    setCheckpointCallCount = 0;
    runBackgroundJobCalls = 0;
    runBackgroundJobLastArgs = null;
    runBackgroundJobShouldThrow = false;
    runBackgroundJobOk = true;
    runBackgroundJobErrorKind = undefined;
    runBackgroundJobErrorMessage = undefined;
    runBackgroundJobSideEffect = null;
    readFileSyncOverride = null;
    updatesConfig.enabled = true;
    if (existsSync(workspacePath)) {
      rmSync(workspacePath);
    }
  });

  afterEach(() => {
    if (existsSync(workspacePath)) {
      rmSync(workspacePath);
    }
  });

  test("config disabled — no job, no checkpoint change", async () => {
    updatesConfig.enabled = false;
    writeFileSync(workspacePath, "## Real content", "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
  });

  test("file missing, stored hash absent — no job; stored becomes 'empty'", async () => {
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file missing, stored hash already 'empty' — no job; no checkpoint write", async () => {
    store.set(HASH_CHECKPOINT_KEY, EMPTY_HASH);
    setCheckpointCallCount = 0;

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present but whitespace-only — treated as empty; stored hash 'empty'", async () => {
    writeFileSync(workspacePath, "   \n\n\t\n", "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present, job ok=true, file unchanged — stored hash is sha256(trimmed); jobName/source are kebab-case", async () => {
    const content = "## Release 1.2.3\n\nNew thing.\n";
    writeFileSync(workspacePath, content, "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(content.trim()));
    expect(runBackgroundJobLastArgs?.jobName).toBe("update-bulletin");
    expect(runBackgroundJobLastArgs?.source).toBe("update-bulletin");
    expect(runBackgroundJobLastArgs?.origin).toBe("updates_bulletin");
    expect(runBackgroundJobLastArgs?.callSite).toBe("mainAgent");
  });

  test("file present, stored hash matches current — no job", async () => {
    const content = "## Release 1.2.3\n\nSame content.\n";
    writeFileSync(workspacePath, content, "utf-8");
    store.set(HASH_CHECKPOINT_KEY, sha256(content.trim()));
    setCheckpointCallCount = 0;

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("runBackgroundJob returns ok=false — checkpoint UNCHANGED so next startup retries", async () => {
    const content = "## Release Q\n\nFailure scenario.\n";
    writeFileSync(workspacePath, content, "utf-8");
    runBackgroundJobOk = false;
    runBackgroundJobErrorKind = "exception";
    runBackgroundJobErrorMessage = "boom";

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(1);
    // Critical: do NOT poison the checkpoint when the job fails.
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("runBackgroundJob ok=true + agent deletes file mid-run — stored hash becomes 'empty'", async () => {
    const content = "## Release X\n\nStuff to process.\n";
    writeFileSync(workspacePath, content, "utf-8");
    runBackgroundJobSideEffect = () => {
      rmSync(workspacePath);
    };

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(1);
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present, stored hash differs — job invoked; stored hash updates", async () => {
    const oldContent = "## Old";
    const newContent = "## New content v2";
    writeFileSync(workspacePath, newContent, "utf-8");
    store.set(HASH_CHECKPOINT_KEY, sha256(oldContent));

    await runUpdateBulletinJobIfNeeded();

    expect(runBackgroundJobCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(newContent.trim()));
    expect(store.get(HASH_CHECKPOINT_KEY)).not.toBe(sha256(oldContent));
  });

  test("file present but readFileSync throws — checkpoint UNCHANGED; warn logged", async () => {
    const content = "## Release U\n\nSimulated read failure.\n";
    writeFileSync(workspacePath, content, "utf-8");

    readFileSyncOverride = (path) => {
      if (typeof path === "string" && path === workspacePath) {
        throw new Error("EACCES simulated");
      }
      return undefined;
    };

    try {
      await runUpdateBulletinJobIfNeeded();
    } finally {
      readFileSyncOverride = null;
    }

    expect(runBackgroundJobCalls).toBe(0);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("runBackgroundJob throws — function does not reject; warning logged", async () => {
    const content = "## Release Z";
    writeFileSync(workspacePath, content, "utf-8");
    runBackgroundJobShouldThrow = true;

    // Must not throw.
    await expect(runUpdateBulletinJobIfNeeded()).resolves.toBeUndefined();

    expect(runBackgroundJobCalls).toBe(1);
    // Hash was never updated because the try/catch returned before the
    // self-healing step.
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
  });
});
