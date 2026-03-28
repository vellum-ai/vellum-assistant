import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureDataDir,
  getDataDir,
  getDbPath,
  getHistoryPath,
  getInterfacesDir,
  getLogPath,
  getPidPath,
  getProtectedDir,
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
    const ws = getWorkspaceDir();
    const root = dirname(ws);
    const data = getDataDir();

    // Workspace is under root
    expect(ws).toBe(join(root, "workspace"));

    // Data dir is under workspace
    expect(data).toBe(join(ws, "data"));

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
    expect(getWorkspaceHooksDir().startsWith(getWorkspaceDir())).toBe(true);
  });

  test("ensureDataDir creates all expected directories", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const ws = getWorkspaceDir();
    const root = dirname(ws);
    const data = getDataDir();

    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }

    ensureDataDir();

    // Root-level dirs (runtime / protected)
    expect(existsSync(root)).toBe(true);
    expect(existsSync(getProtectedDir())).toBe(true);

    // Workspace dirs
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(getWorkspaceHooksDir())).toBe(true);
    expect(existsSync(getWorkspaceSkillsDir())).toBe(true);

    // Data sub-dirs under workspace
    expect(existsSync(data)).toBe(true);
    expect(existsSync(join(data, "db"))).toBe(true);
    expect(existsSync(join(data, "qdrant"))).toBe(true);
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(existsSync(join(data, "memory"))).toBe(true);
    expect(existsSync(join(data, "memory", "knowledge"))).toBe(true);
    expect(existsSync(join(data, "apps"))).toBe(true);
    expect(existsSync(join(data, "interfaces"))).toBe(true);

    // Legacy dirs should NOT be created
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(root, "data", "sandbox"))).toBe(false);
    expect(existsSync(join(root, "data", "sandbox", "fs"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("workspace path primitives", () => {
  test("workspace helpers resolve under workspace dir", () => {
    const base = join(
      tmpdir(),
      `platform-test-${randomBytes(4).toString("hex")}`,
    );
    process.env.BASE_DATA_DIR = base;
    const ws = getWorkspaceDir();

    expect(getWorkspaceConfigPath()).toBe(join(ws, "config.json"));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, "skills"));
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));
    expect(getWorkspacePromptPath("IDENTITY.md")).toBe(join(ws, "IDENTITY.md"));
    expect(getWorkspacePromptPath("SOUL.md")).toBe(join(ws, "SOUL.md"));
    expect(getWorkspacePromptPath("USER.md")).toBe(join(ws, "USER.md"));
  });
});
