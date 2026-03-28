import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureDataDir,
  getDataDir,
  getDbPath,
  getHistoryPath,
  getInterfacesDir,
  getLogPath,
  getPidPath,
  getRootDir,
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
} from "../util/platform.js";

const originalBaseDataDir = process.env.BASE_DATA_DIR;

afterEach(() => {
  if (originalBaseDataDir == null) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = originalBaseDataDir;
  }
});

// Baseline path characterization: documents current pre-migration path layout.
// After workspace migration, paths marked "WILL MOVE" below will resolve under
// ~/.vellum/workspace/ instead. Paths marked "STAYS ROOT" remain at ~/.vellum/.
describe("baseline path characterization (pre-migration)", () => {
  test("all path helpers resolve to expected pre-migration locations", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const root = join(base, ".vellum");
    const data = join(root, "workspace", "data");

    // Root dir — stays as anchor for all paths
    expect(getRootDir()).toBe(root);

    // Now resolves under workspace/data
    expect(getDataDir()).toBe(join(root, "workspace", "data"));

    // Sub-paths under workspace/data
    expect(getDbPath()).toBe(join(data, "db", "assistant.db"));
    expect(getLogPath()).toBe(join(data, "logs", "vellum.log"));
    expect(getHistoryPath()).toBe(join(data, "history"));
    expect(getInterfacesDir()).toBe(join(data, "interfaces"));
    expect(getSandboxRootDir()).toBe(join(data, "sandbox"));
    expect(getSandboxWorkingDir()).toBe(join(root, "workspace"));

    // Hooks now live under workspace
    expect(getWorkspaceHooksDir()).toBe(join(root, "workspace", "hooks"));

    // STAYS ROOT — runtime files remain at ~/.vellum/
    expect(getPidPath()).toBe(join(root, "vellum.pid"));
  });

  test("hooks directory is inside the workspace boundary", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const hooksDir = getWorkspaceHooksDir();
    const workspaceDir = getWorkspaceDir();
    expect(hooksDir.startsWith(workspaceDir)).toBe(true);
  });

  test("ensureDataDir creates all expected directories", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const rootDir = getRootDir();
    const ws = getWorkspaceDir();
    const wsData = join(ws, "data");

    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }

    ensureDataDir();

    // Root-level dirs (runtime / protected)
    expect(existsSync(getRootDir())).toBe(true);
    expect(existsSync(join(getRootDir(), "protected"))).toBe(true);

    // Workspace dirs
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(ws, "hooks"))).toBe(true);
    expect(existsSync(join(ws, "skills"))).toBe(true);

    // Data sub-dirs under workspace
    expect(existsSync(wsData)).toBe(true);
    expect(existsSync(join(wsData, "db"))).toBe(true);
    expect(existsSync(join(wsData, "qdrant"))).toBe(true);
    expect(existsSync(join(wsData, "logs"))).toBe(true);
    expect(existsSync(join(wsData, "memory"))).toBe(true);
    expect(existsSync(join(wsData, "memory", "knowledge"))).toBe(true);
    expect(existsSync(join(wsData, "apps"))).toBe(true);
    expect(existsSync(join(wsData, "interfaces"))).toBe(true);

    // Legacy dirs should NOT be created
    expect(existsSync(join(getRootDir(), "skills"))).toBe(false);
    expect(existsSync(join(getRootDir(), "data", "sandbox"))).toBe(false);
    expect(existsSync(join(getRootDir(), "data", "sandbox", "fs"))).toBe(false);

    rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("workspace path primitives", () => {
  test("workspace helpers resolve under getRootDir()/workspace", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const root = join(base, ".vellum");
    const ws = join(root, "workspace");

    expect(getWorkspaceDir()).toBe(ws);
    expect(getWorkspaceConfigPath()).toBe(join(ws, "config.json"));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, "skills"));
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));
    expect(getWorkspacePromptPath("IDENTITY.md")).toBe(join(ws, "IDENTITY.md"));
    expect(getWorkspacePromptPath("SOUL.md")).toBe(join(ws, "SOUL.md"));
    expect(getWorkspacePromptPath("USER.md")).toBe(join(ws, "USER.md"));
  });

  test("workspace helpers honor BASE_DATA_DIR", () => {
    process.env.BASE_DATA_DIR = "/tmp/custom-base";
    expect(getWorkspaceDir()).toBe("/tmp/custom-base/.vellum/workspace");
  });
});
