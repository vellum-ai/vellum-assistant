import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  acquireWorkspaceGitRepoLock,
  getWorkspaceGitRepoLockPath,
  withWorkspaceGitRepoLock,
  WORKSPACE_GIT_REPO_LOCK_STALE_TTL_MS,
  WorkspaceGitRepoLockTimeout,
} from "../workspace/git-repo-lock.js";

let ROOT: string;
let LOCK: string;

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "vellum-git-repo-lock-"));
  LOCK = getWorkspaceGitRepoLockPath(ROOT);
});

afterEach(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("workspace git repo lock", () => {
  test("acquire creates the lock file; release removes it", async () => {
    const release = await acquireWorkspaceGitRepoLock(LOCK);
    expect(existsSync(LOCK)).toBe(true);
    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("release is idempotent", async () => {
    const release = await acquireWorkspaceGitRepoLock(LOCK);
    await release();
    await release();
    expect(existsSync(LOCK)).toBe(false);
  });

  test("withWorkspaceGitRepoLock serializes two waiters", async () => {
    const order: string[] = [];
    const first = withWorkspaceGitRepoLock(ROOT, async () => {
      order.push("a-start");
      await Bun.sleep(50);
      order.push("a-end");
    });
    const second = withWorkspaceGitRepoLock(ROOT, async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([first, second]);
    expect([
      ["a-start", "a-end", "b-start", "b-end"],
      ["b-start", "b-end", "a-start", "a-end"],
    ]).toContainEqual(order);
  });

  test("deadline skip while another holder is live", async () => {
    const release = await acquireWorkspaceGitRepoLock(LOCK);
    try {
      await expect(
        acquireWorkspaceGitRepoLock(LOCK, { deadlineMs: Date.now() + 80 }),
      ).rejects.toBeInstanceOf(WorkspaceGitRepoLockTimeout);
    } finally {
      await release();
    }
  });

  test("dead PID lock is taken over", async () => {
    const deadPid = 2_147_483_647;
    writeFileSync(LOCK, `${deadPid} ${Date.now()}\n`, { mode: 0o600 });
    const release = await acquireWorkspaceGitRepoLock(LOCK);
    try {
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      await release();
    }
    expect(existsSync(LOCK)).toBe(false);
  });

  test("expired TTL lock is taken over even if the PID looks alive", async () => {
    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const staleTs = Date.now() - WORKSPACE_GIT_REPO_LOCK_STALE_TTL_MS - 1_000;
    writeFileSync(LOCK, `${child.pid} ${staleTs}\n`, { mode: 0o600 });
    try {
      const release = await acquireWorkspaceGitRepoLock(LOCK, {
        deadlineMs: Date.now() + 1_000,
      });
      try {
        expect(existsSync(LOCK)).toBe(true);
      } finally {
        await release();
      }
    } finally {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
