import { afterEach, describe, expect, test } from "bun:test";

import { ensureDaemonRunning } from "../daemon/daemon-control.js";

// getDaemonStatus() reads a workspace-scoped PID file that never exists under
// the per-test tmp workspace, so on a pod with no reachable daemon
// ensureDaemonRunning() must throw before it can spawn a rival. IS_PLATFORM is
// used without IS_CONTAINERIZED so the status probe falls through to the
// PID-file path (getDaemonStatus() reports "running" unconditionally when
// containerized, which would short-circuit before the guard).
describe("ensureDaemonRunning pod guard", () => {
  const savedPlatform = process.env.IS_PLATFORM;
  const savedContainerized = process.env.IS_CONTAINERIZED;

  afterEach(() => {
    if (savedPlatform === undefined) {
      delete process.env.IS_PLATFORM;
    } else {
      process.env.IS_PLATFORM = savedPlatform;
    }
    if (savedContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = savedContainerized;
    }
  });

  test("errors instead of spawning when platform-managed and unreachable", async () => {
    delete process.env.IS_CONTAINERIZED;
    process.env.IS_PLATFORM = "true";
    // Throwing here proves the guard fires ahead of startDaemon(), the only
    // path that would spawn a daemon.
    await expect(ensureDaemonRunning()).rejects.toThrow(/unreachable/i);
  });
});
