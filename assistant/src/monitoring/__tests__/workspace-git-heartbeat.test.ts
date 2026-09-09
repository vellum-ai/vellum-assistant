/**
 * The workspace git auto-commit heartbeat runs in the resource monitor
 * process, not on the daemon event loop. These tests cover the monitor-side
 * starter (registry wiring + stop) and a source guard so the timer is not
 * put back on the daemon.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { getWorkspaceDir } from "../../util/platform.js";
import {
  _resetGitServiceRegistry,
  getAllWorkspaceGitServices,
} from "../../workspace/git-service.js";
import { _resetHeartbeatServiceForTests } from "../../workspace/heartbeat-service.js";
import { startWorkspaceGitHeartbeat } from "../workspace-git-heartbeat.js";

const SRC_ROOT = join(import.meta.dir, "../..");

describe("workspace git heartbeat on the monitoring worker", () => {
  afterEach(async () => {
    await _resetHeartbeatServiceForTests();
    _resetGitServiceRegistry();
  });

  test("registers the default workspace before starting the timer", async () => {
    await _resetHeartbeatServiceForTests();
    _resetGitServiceRegistry();
    const handle = startWorkspaceGitHeartbeat();
    try {
      expect(getAllWorkspaceGitServices().has(getWorkspaceDir())).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  test("stop is idempotent", async () => {
    await _resetHeartbeatServiceForTests();
    _resetGitServiceRegistry();
    const handle = startWorkspaceGitHeartbeat();
    await handle.stop();
    await handle.stop();
  });

  test("resource monitor starts the heartbeat and daemon lifecycle does not", () => {
    const worker = readFileSync(join(SRC_ROOT, "monitoring/worker.ts"), "utf8");
    const lifecycle = readFileSync(
      join(SRC_ROOT, "daemon/lifecycle.ts"),
      "utf8",
    );
    expect(worker).toContain("startWorkspaceGitHeartbeat(");
    expect(worker).toContain("await workspaceGitHeartbeat?.stop()");
    expect(lifecycle).not.toContain("startWorkspaceHeartbeatService");
  });
});
