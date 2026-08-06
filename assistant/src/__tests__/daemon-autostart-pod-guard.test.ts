import { afterEach, describe, expect, test } from "bun:test";

import { ensureDaemonRunning } from "../daemon/daemon-control.js";

// On a container the orchestrator owns the daemon lifecycle, so
// ensureDaemonRunning() must never spawn one. getDaemonStatus() reports
// containerized instances as running, so ensureDaemonRunning() returns at its
// status.running check without reaching startDaemon() (the only spawn path).
describe("ensureDaemonRunning on a container", () => {
  const savedContainerized = process.env.IS_CONTAINERIZED;

  afterEach(() => {
    if (savedContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = savedContainerized;
    }
  });

  test("returns without spawning a daemon", async () => {
    process.env.IS_CONTAINERIZED = "true";
    await expect(ensureDaemonRunning()).resolves.toBeUndefined();
  });
});
