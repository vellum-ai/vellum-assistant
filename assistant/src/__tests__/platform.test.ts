import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureDataDir,
  getDataDir,
  getDbPath,
  getDotEnvPath,
  getHistoryPath,
  getInterfacesDir,
  getLogPath,
  getPidPath,
  getProtectedDir,
  getRuntimePortFilePath,
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
  getXdgPlatformTokenPath,
  getXdgVellumConfigDirName,
} from "../util/platform.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const originalBaseDataDir = process.env.BASE_DATA_DIR;
const originalVellumEnvironment = process.env.VELLUM_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalWorkspaceDir == null) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalBaseDataDir == null) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = originalBaseDataDir;
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

    // Root-level runtime files remain at ~/.vellum/
    expect(getPidPath()).toBe(join(root, "vellum.pid"));
  });

  test("VELLUM_WORKSPACE_DIR overrides workspace location", () => {
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/custom-workspace";
    expect(getWorkspaceDir()).toBe("/tmp/custom-workspace");
    expect(getDataDir()).toBe("/tmp/custom-workspace/data");
    // Root-level paths are NOT affected by VELLUM_WORKSPACE_DIR
    expect(getPidPath()).toBe(join(homedir(), ".vellum", "vellum.pid"));
  });

  test("BASE_DATA_DIR relocates vellumRoot()-derived paths", () => {
    const saved = process.env.BASE_DATA_DIR;
    process.env.BASE_DATA_DIR = "/tmp/fake-instance";
    try {
      delete process.env.VELLUM_WORKSPACE_DIR;
      expect(getPidPath()).toBe("/tmp/fake-instance/.vellum/vellum.pid");
      expect(getProtectedDir()).toBe("/tmp/fake-instance/.vellum/protected");
      expect(getRuntimePortFilePath()).toBe(
        "/tmp/fake-instance/.vellum/runtime-port",
      );
      expect(getDotEnvPath()).toBe("/tmp/fake-instance/.vellum/.env");
      // Workspace transitively relocates via vellumRoot()
      expect(getWorkspaceDir()).toBe("/tmp/fake-instance/.vellum/workspace");
    } finally {
      if (saved === undefined) delete process.env.BASE_DATA_DIR;
      else process.env.BASE_DATA_DIR = saved;
    }
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
    const root = join(homedir(), ".vellum");
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

describe("XDG platform-token path env-awareness", () => {
  test("production returns ~/.config/vellum/platform-token", () => {
    delete process.env.VELLUM_ENVIRONMENT;
    delete process.env.XDG_CONFIG_HOME;
    expect(getXdgVellumConfigDirName()).toBe("vellum");
    expect(getXdgPlatformTokenPath()).toBe(
      join(homedir(), ".config", "vellum", "platform-token"),
    );
  });

  test("production (explicit) returns ~/.config/vellum/platform-token", () => {
    process.env.VELLUM_ENVIRONMENT = "production";
    delete process.env.XDG_CONFIG_HOME;
    expect(getXdgVellumConfigDirName()).toBe("vellum");
    expect(getXdgPlatformTokenPath()).toBe(
      join(homedir(), ".config", "vellum", "platform-token"),
    );
  });

  test("dev environment returns $XDG_CONFIG_HOME/vellum-dev/platform-token", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = "/tmp/fake-xdg";
    expect(getXdgVellumConfigDirName()).toBe("vellum-dev");
    expect(getXdgPlatformTokenPath()).toBe(
      "/tmp/fake-xdg/vellum-dev/platform-token",
    );
  });

  test.each(["staging", "test", "local"])(
    "%s environment returns env-scoped path",
    (env) => {
      process.env.VELLUM_ENVIRONMENT = env;
      process.env.XDG_CONFIG_HOME = "/tmp/fake-xdg";
      expect(getXdgVellumConfigDirName()).toBe(`vellum-${env}`);
      expect(getXdgPlatformTokenPath()).toBe(
        `/tmp/fake-xdg/vellum-${env}/platform-token`,
      );
    },
  );

  test("unknown environment falls back to production path", () => {
    process.env.VELLUM_ENVIRONMENT = "no-such-env";
    process.env.XDG_CONFIG_HOME = "/tmp/fake-xdg";
    expect(getXdgVellumConfigDirName()).toBe("vellum");
    expect(getXdgPlatformTokenPath()).toBe(
      "/tmp/fake-xdg/vellum/platform-token",
    );
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
