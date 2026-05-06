import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
  getXdgVellumConfigDirName,
  vellumRoot,
} from "../util/platform.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalVellumEnvironment = process.env.VELLUM_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalWorkspaceDir == null) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalVellumEnvironment == null) {
    delete process.env.VELLUM_ENVIRONMENT;
  } else {
    process.env.VELLUM_ENVIRONMENT = originalVellumEnvironment;
  }
  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

// Path characterization: documents the current path layout.
// Root-level helpers always resolve under ~/.vellum (from homedir()).
// Workspace helpers resolve under VELLUM_WORKSPACE_DIR when set,
// otherwise under ~/.vellum/workspace.
describe("path characterization", () => {
  test("all path helpers resolve to expected locations", () => {
    // Without VELLUM_WORKSPACE_DIR override, workspace is under ~/.vellum
    delete process.env.VELLUM_WORKSPACE_DIR;
    const root = join(homedir(), ".vellum");
    const ws = getWorkspaceDir();
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
    expect(getSandboxWorkingDir()).toBe(ws);

    // Hooks live under workspace
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));

    // PID file lives in the workspace directory
    expect(getPidPath()).toBe(join(ws, "vellum.pid"));
  });

  test("VELLUM_WORKSPACE_DIR overrides workspace location", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/custom-workspace";
    expect(getWorkspaceDir()).toBe("/tmp/custom-workspace");
    expect(getDataDir()).toBe("/tmp/custom-workspace/data");
    // PID path follows workspace override
    expect(getPidPath()).toBe("/tmp/custom-workspace/vellum.pid");
  });

  test("hooks directory is inside the workspace boundary", () => {
    delete process.env.VELLUM_WORKSPACE_DIR;
    expect(getWorkspaceHooksDir().startsWith(getWorkspaceDir())).toBe(true);
  });

  test("ensureDataDir creates all expected directories", () => {
    // Use a temp VELLUM_WORKSPACE_DIR so ensureDataDir writes to a temp dir
    // rather than the real ~/.vellum. Root-level dirs still go to ~/.vellum
    // but we only verify workspace dirs here to avoid side effects.
    const wsDir = join(tmpdir(), `platform-test-ws-${Date.now()}`);
    process.env.VELLUM_WORKSPACE_DIR = wsDir;

    ensureDataDir();

    // Root-level dirs (ensureDataDir always creates these)
    const root = vellumRoot();
    expect(existsSync(root)).toBe(true);

    // Workspace dirs (in our temp location)
    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(join(wsDir, "skills"))).toBe(true);

    // Data sub-dirs under workspace
    const data = join(wsDir, "data");
    expect(existsSync(data)).toBe(true);
    expect(existsSync(join(data, "db"))).toBe(true);
    expect(existsSync(join(data, "qdrant"))).toBe(true);
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(existsSync(join(data, "memory"))).toBe(true);
    expect(existsSync(join(data, "memory", "knowledge"))).toBe(true);
    expect(existsSync(join(data, "apps"))).toBe(true);
    expect(existsSync(join(data, "interfaces"))).toBe(true);

    rmSync(wsDir, { recursive: true, force: true });
  });
});

describe("XDG config dir name env-awareness", () => {
  test("production returns vellum", () => {
    delete process.env.VELLUM_ENVIRONMENT;
    delete process.env.XDG_CONFIG_HOME;
    expect(getXdgVellumConfigDirName()).toBe("vellum");
  });

  test("production (explicit) returns vellum", () => {
    process.env.VELLUM_ENVIRONMENT = "production";
    expect(getXdgVellumConfigDirName()).toBe("vellum");
  });

  test("dev environment returns vellum-dev", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    expect(getXdgVellumConfigDirName()).toBe("vellum-dev");
  });

  test.each(["staging", "test", "local"])(
    "%s environment returns vellum-%s",
    (env) => {
      process.env.VELLUM_ENVIRONMENT = env;
      expect(getXdgVellumConfigDirName()).toBe(`vellum-${env}`);
    },
  );

  test("unknown environment falls back to production", () => {
    process.env.VELLUM_ENVIRONMENT = "no-such-env";
    expect(getXdgVellumConfigDirName()).toBe("vellum");
  });
});

describe("workspace path primitives", () => {
  test("workspace helpers resolve under workspace dir", () => {
    delete process.env.VELLUM_WORKSPACE_DIR;
    const ws = getWorkspaceDir();

    expect(getWorkspaceConfigPath()).toBe(join(ws, "config.json"));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, "skills"));
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));
    expect(getWorkspacePromptPath("IDENTITY.md")).toBe(join(ws, "IDENTITY.md"));
    expect(getWorkspacePromptPath("SOUL.md")).toBe(join(ws, "SOUL.md"));
  });
});
