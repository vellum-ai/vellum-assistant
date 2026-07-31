import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveNginxIngressTarget } from "../commands/nginx-ingress.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-nginx-ingress-command-test-"));
const workspaceDir = join(testDir, "workspace");
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

function writeLockfile(
  entries: AssistantEntry[],
  activeAssistant?: string,
): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: entries,
        ...(activeAssistant ? { activeAssistant } : {}),
      },
      null,
      2,
    ),
  );
}

describe("resolveNginxIngressTarget", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    if (originalWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("derives the gateway port from runtimeUrl when resources are absent", () => {
    writeLockfile([
      {
        assistantId: "docker-assistant",
        name: "Docker Assistant",
        runtimeUrl: "http://localhost:9123",
        cloud: "docker",
      },
    ]);

    expect(resolveNginxIngressTarget("Docker Assistant")).toEqual({
      assistantId: "docker-assistant",
      workspaceDir,
      gatewayPort: 9123,
    });
  });
});
