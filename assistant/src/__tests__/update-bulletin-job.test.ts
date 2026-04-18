import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { getWorkspacePromptPath } from "../util/platform.js";

// ── fs.readFileSync override (for gap 3 test) ────────────────────────
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

// ── bootstrapConversation + wakeAgentForOpportunity mocks ────────────
let bootstrapCalls = 0;
let bootstrapLastArgs: Record<string, unknown> | null = null;
let wakeCalls = 0;
let wakeLastArgs: Record<string, unknown> | null = null;
let wakeShouldThrow = false;
let wakeInvoked = true;
let wakeProducedToolCalls = false;
// A side-effect function invoked during wake. Lets tests simulate the
// agent deleting UPDATES.md while the wake is in flight.
let wakeSideEffect: (() => void) | null = null;

mock.module("../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: (opts: Record<string, unknown>) => {
    bootstrapCalls += 1;
    bootstrapLastArgs = opts;
    return { id: `conv-${bootstrapCalls}` };
  },
}));

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async (opts: Record<string, unknown>) => {
    wakeCalls += 1;
    wakeLastArgs = opts;
    if (wakeSideEffect) {
      wakeSideEffect();
    }
    if (wakeShouldThrow) {
      throw new Error("simulated wake failure");
    }
    return {
      invoked: wakeInvoked,
      producedToolCalls: wakeProducedToolCalls,
    };
  },
}));

const { runUpdateBulletinJobIfNeeded } = await import(
  "../prompts/update-bulletin-job.js"
);

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
    bootstrapCalls = 0;
    bootstrapLastArgs = null;
    wakeCalls = 0;
    wakeLastArgs = null;
    wakeShouldThrow = false;
    wakeInvoked = true;
    wakeProducedToolCalls = false;
    wakeSideEffect = null;
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

  test("config disabled — no bootstrap, no wake, no checkpoint change", async () => {
    updatesConfig.enabled = false;
    writeFileSync(workspacePath, "## Real content", "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
  });

  test("file missing, stored hash absent — no wake; stored becomes 'empty'", async () => {
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file missing, stored hash already 'empty' — no wake; no checkpoint write", async () => {
    store.set(HASH_CHECKPOINT_KEY, EMPTY_HASH);
    // Reset the counter to ignore the priming write above.
    setCheckpointCallCount = 0;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present but whitespace-only — treated as empty; stored hash 'empty'", async () => {
    writeFileSync(workspacePath, "   \n\n\t\n", "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present with content, wake produced tool calls — bootstrap + wake; stored hash is sha256(trimmed); source/origin are snake_case", async () => {
    const content = "## Release 1.2.3\n\nNew thing.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeProducedToolCalls = true;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(content.trim()));
    // Gap 4: confirm snake_case reached the downstream mocks.
    expect(bootstrapLastArgs?.source).toBe("updates_bulletin");
    expect(bootstrapLastArgs?.origin).toBe("updates_bulletin");
    expect(wakeLastArgs?.source).toBe("updates_bulletin");
  });

  test("file present, stored hash matches current — no wake", async () => {
    const content = "## Release 1.2.3\n\nSame content.\n";
    writeFileSync(workspacePath, content, "utf-8");
    store.set(HASH_CHECKPOINT_KEY, sha256(content.trim()));
    setCheckpointCallCount = 0;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("wake returns invoked:false — checkpoint UNCHANGED (resolver not registered case)", async () => {
    const content = "## Release Q\n\nResolver-missing scenario.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeInvoked = false;
    wakeProducedToolCalls = false;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    // Critical: do NOT poison the checkpoint.
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("wake invoked but no tool calls AND file unchanged — checkpoint UNCHANGED (retry next startup)", async () => {
    const content = "## Release R\n\nSilent no-op scenario.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeInvoked = true;
    wakeProducedToolCalls = false;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("wake invoked, no tool calls, but file deleted mid-wake — checkpoint becomes 'empty'", async () => {
    const content = "## Release S\n\nAgent deleted file.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeInvoked = true;
    wakeProducedToolCalls = false;
    wakeSideEffect = () => {
      rmSync(workspacePath);
    };

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("wake invoked + produced tool calls + file unchanged — checkpoint = hash of content (agent decided this is the right state)", async () => {
    const content = "## Release T\n\nAgent processed, chose to leave file.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeInvoked = true;
    wakeProducedToolCalls = true;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(content.trim()));
  });

  test("file present, stored hash differs — wake invoked; stored hash updates", async () => {
    const oldContent = "## Old";
    const newContent = "## New content v2";
    writeFileSync(workspacePath, newContent, "utf-8");
    store.set(HASH_CHECKPOINT_KEY, sha256(oldContent));
    wakeProducedToolCalls = true;

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(newContent.trim()));
    expect(store.get(HASH_CHECKPOINT_KEY)).not.toBe(sha256(oldContent));
  });

  test("agent deletes file mid-wake (producedToolCalls=true) — stored hash becomes 'empty'", async () => {
    const content = "## Release X\n\nStuff to process.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeProducedToolCalls = true;
    wakeSideEffect = () => {
      rmSync(workspacePath);
    };

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("file present but readFileSync throws — checkpoint UNCHANGED; warn logged (gap 3)", async () => {
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

    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
    expect(setCheckpointCallCount).toBe(0);
  });

  test("wake throws — function does not reject; warning logged", async () => {
    const content = "## Release Z";
    writeFileSync(workspacePath, content, "utf-8");
    wakeShouldThrow = true;

    // Must not throw.
    await expect(runUpdateBulletinJobIfNeeded()).resolves.toBeUndefined();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    // Hash was never updated because the try/catch returned before the
    // self-healing step.
    expect(store.has(HASH_CHECKPOINT_KEY)).toBe(false);
  });
});
