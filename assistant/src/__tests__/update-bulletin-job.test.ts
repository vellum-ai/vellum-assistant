import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { getWorkspacePromptPath } from "../util/platform.js";

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
let wakeCalls = 0;
let wakeShouldThrow = false;
// A side-effect function invoked during wake. Lets tests simulate the
// agent deleting UPDATES.md while the wake is in flight.
let wakeSideEffect: (() => void) | null = null;

mock.module("../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: (_opts: unknown) => {
    bootstrapCalls += 1;
    return { id: `conv-${bootstrapCalls}` };
  },
}));

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async () => {
    wakeCalls += 1;
    if (wakeSideEffect) {
      wakeSideEffect();
    }
    if (wakeShouldThrow) {
      throw new Error("simulated wake failure");
    }
    return { invoked: true, producedToolCalls: false };
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
    wakeCalls = 0;
    wakeShouldThrow = false;
    wakeSideEffect = null;
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

  test("file present with content, stored hash absent — bootstrap + wake; stored hash is sha256(trimmed)", async () => {
    const content = "## Release 1.2.3\n\nNew thing.\n";
    writeFileSync(workspacePath, content, "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(content.trim()));
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

  test("file present, stored hash differs — wake invoked; stored hash updates", async () => {
    const oldContent = "## Old";
    const newContent = "## New content v2";
    writeFileSync(workspacePath, newContent, "utf-8");
    store.set(HASH_CHECKPOINT_KEY, sha256(oldContent));

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(newContent.trim()));
    expect(store.get(HASH_CHECKPOINT_KEY)).not.toBe(sha256(oldContent));
  });

  test("agent deletes file mid-wake — stored hash becomes 'empty'", async () => {
    const content = "## Release X\n\nStuff to process.\n";
    writeFileSync(workspacePath, content, "utf-8");
    wakeSideEffect = () => {
      rmSync(workspacePath);
    };

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(existsSync(workspacePath)).toBe(false);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(EMPTY_HASH);
  });

  test("wake completes but file unchanged — stored hash = hash of content; rerun is a no-op", async () => {
    const content = "## Release Y\n\nAgent chose to no-op.\n";
    writeFileSync(workspacePath, content, "utf-8");

    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
    expect(store.get(HASH_CHECKPOINT_KEY)).toBe(sha256(content.trim()));

    // Second run — hash matches, so we short-circuit before bootstrap/wake.
    await runUpdateBulletinJobIfNeeded();

    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
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
