import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test gets a fresh, uniquely-named flag directory. Reusing one path
// across tests (rm + recreate) leaves fs.watch bound to a stale inode, so
// file events on the recreated directory are silently dropped.
let flagDir = "";

mock.module("../feature-flag-store.js", () => ({
  clearFeatureFlagStoreCache: mock(() => {}),
  getFeatureFlagStorePath: () => join(flagDir, "feature-flags.json"),
}));

mock.module("../feature-flag-remote-store.js", () => ({
  refreshRemoteFeatureFlagStoreCache: mock(() => {}),
  getRemoteFeatureFlagStorePath: () =>
    join(flagDir, "remote-feature-flags.json"),
}));

const { FeatureFlagWatcher } = await import("../feature-flag-watcher.js");

describe("FeatureFlagWatcher onChanged callback", () => {
  beforeEach(() => {
    flagDir = mkdtempSync(join(tmpdir(), "ff-watcher-test-"));
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(join(flagDir, "feature-flags.json"), "{}");
  });

  afterEach(() => {
    try {
      rmSync(flagDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("calls onChanged after debounce fires on local flag file change", async () => {
    const onChanged = mock(() => {});
    const watcher = new FeatureFlagWatcher({ onChanged });
    watcher.start();

    writeFileSync(
      join(flagDir, "feature-flags.json"),
      JSON.stringify({ test: true }),
    );

    await new Promise((r) => setTimeout(r, 700));

    expect(onChanged).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test("calls onChanged after debounce fires on remote flag file change", async () => {
    const onChanged = mock(() => {});
    const watcher = new FeatureFlagWatcher({ onChanged });
    watcher.start();

    writeFileSync(
      join(flagDir, "remote-feature-flags.json"),
      JSON.stringify({ remote: true }),
    );

    await new Promise((r) => setTimeout(r, 700));

    expect(onChanged).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  test("does not call onChanged when no callback is provided", async () => {
    const watcher = new FeatureFlagWatcher();
    watcher.start();

    writeFileSync(
      join(flagDir, "feature-flags.json"),
      JSON.stringify({ test: true }),
    );

    await new Promise((r) => setTimeout(r, 700));

    // No assertion needed — just verify no error is thrown
    watcher.stop();
  });
});
