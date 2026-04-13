import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const TEST_HOME = "/test/home";

// Mock homedir() so the helpers return predictable paths regardless of who
// is running the test. `os.homedir()` is read once per process on Bun/Node
// and does not reflect later $HOME changes, so setting process.env.HOME at
// test time does not work — module mocking is the recommended pattern (see
// cli/src/__tests__/multi-local.test.ts).
const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => TEST_HOME,
}));
mock.module("os", () => ({
  ...realOs,
  homedir: () => TEST_HOME,
}));

// Imports that depend on the mocked `os` module must come after the
// mock.module() calls above.
const {
  getConfigDir,
  getDataDir,
  getDefaultPorts,
  getLockfilePath,
  getLockfilePaths,
  getMultiInstanceDir,
} = await import("../paths.js");
type EnvironmentDefinition = import("../types.js").EnvironmentDefinition;

const prod: EnvironmentDefinition = {
  name: "production",
  platformUrl: "https://platform.vellum.ai",
};

const dev: EnvironmentDefinition = {
  name: "dev",
  platformUrl: "https://dev-platform.vellum.ai",
};

const XDG_ENV_VARS = ["XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const;

describe("path helpers", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of XDG_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("getDataDir", () => {
    test("production returns legacy ~/.vellum/", () => {
      expect(getDataDir(prod)).toBe(join(TEST_HOME, ".vellum"));
    });

    test("dev returns ~/.local/share/vellum-dev/ by default", () => {
      expect(getDataDir(dev)).toBe(
        join(TEST_HOME, ".local", "share", "vellum-dev"),
      );
    });

    test("staging returns ~/.local/share/vellum-staging/ by default", () => {
      const staging: EnvironmentDefinition = {
        name: "staging",
        platformUrl: "https://staging-platform.vellum.ai",
      };
      expect(getDataDir(staging)).toBe(
        join(TEST_HOME, ".local", "share", "vellum-staging"),
      );
    });

    test("respects XDG_DATA_HOME for non-prod envs", () => {
      process.env.XDG_DATA_HOME = "/custom/data";
      expect(getDataDir(dev)).toBe("/custom/data/vellum-dev");
    });

    test("XDG_DATA_HOME does not affect production (legacy path)", () => {
      process.env.XDG_DATA_HOME = "/custom/data";
      expect(getDataDir(prod)).toBe(join(TEST_HOME, ".vellum"));
    });

    test("respects env.dataDirOverride for production", () => {
      const env: EnvironmentDefinition = {
        ...prod,
        dataDirOverride: "/tmp/test",
      };
      expect(getDataDir(env)).toBe("/tmp/test");
    });

    test("respects env.dataDirOverride for non-prod", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        dataDirOverride: "/tmp/test",
      };
      expect(getDataDir(env)).toBe("/tmp/test");
    });
  });

  describe("getConfigDir", () => {
    test("production returns ~/.config/vellum/", () => {
      expect(getConfigDir(prod)).toBe(join(TEST_HOME, ".config", "vellum"));
    });

    test("dev returns ~/.config/vellum-dev/", () => {
      expect(getConfigDir(dev)).toBe(join(TEST_HOME, ".config", "vellum-dev"));
    });

    test("respects XDG_CONFIG_HOME for non-prod envs", () => {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      expect(getConfigDir(dev)).toBe("/custom/config/vellum-dev");
    });

    test("respects XDG_CONFIG_HOME for production too", () => {
      // Production's XDG config dir already follows XDG conventions, so the
      // standard XDG override applies.
      process.env.XDG_CONFIG_HOME = "/custom/config";
      expect(getConfigDir(prod)).toBe("/custom/config/vellum");
    });

    test("respects env.configDirOverride", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        configDirOverride: "/tmp/cfg",
      };
      expect(getConfigDir(env)).toBe("/tmp/cfg");
    });
  });

  describe("getLockfilePath", () => {
    test("production returns ~/.vellum.lock.json", () => {
      expect(getLockfilePath(prod)).toBe(join(TEST_HOME, ".vellum.lock.json"));
    });

    test("dev returns ~/.config/vellum-dev/lockfile.json", () => {
      expect(getLockfilePath(dev)).toBe(
        join(TEST_HOME, ".config", "vellum-dev", "lockfile.json"),
      );
    });

    test("non-prod respects configDirOverride", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        configDirOverride: "/tmp/cfg",
      };
      expect(getLockfilePath(env)).toBe("/tmp/cfg/lockfile.json");
    });

    test("production respects lockfileDirOverride", () => {
      const env: EnvironmentDefinition = {
        ...prod,
        lockfileDirOverride: "/tmp/lock",
      };
      expect(getLockfilePath(env)).toBe("/tmp/lock/.vellum.lock.json");
    });

    test("non-prod respects lockfileDirOverride (overrides configDir)", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        configDirOverride: "/tmp/cfg",
        lockfileDirOverride: "/tmp/lock",
      };
      expect(getLockfilePath(env)).toBe("/tmp/lock/lockfile.json");
    });
  });

  describe("getLockfilePaths", () => {
    test("production returns both current and legacy filenames in priority order", () => {
      expect(getLockfilePaths(prod)).toEqual([
        join(TEST_HOME, ".vellum.lock.json"),
        join(TEST_HOME, ".vellum.lockfile.json"),
      ]);
    });

    test("non-prod returns a single canonical path", () => {
      expect(getLockfilePaths(dev)).toEqual([
        join(TEST_HOME, ".config", "vellum-dev", "lockfile.json"),
      ]);
    });

    test("production with lockfileDirOverride applies to both candidates", () => {
      const env: EnvironmentDefinition = {
        ...prod,
        lockfileDirOverride: "/tmp/lock",
      };
      expect(getLockfilePaths(env)).toEqual([
        "/tmp/lock/.vellum.lock.json",
        "/tmp/lock/.vellum.lockfile.json",
      ]);
    });

    test("non-prod with lockfileDirOverride overrides the config dir", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        lockfileDirOverride: "/tmp/lock",
      };
      expect(getLockfilePaths(env)).toEqual(["/tmp/lock/lockfile.json"]);
    });

    test("getLockfilePath returns the first entry from getLockfilePaths", () => {
      expect(getLockfilePath(prod)).toBe(getLockfilePaths(prod)[0]);
      expect(getLockfilePath(dev)).toBe(getLockfilePaths(dev)[0]);
    });
  });

  describe("getMultiInstanceDir", () => {
    test("production returns ~/.local/share/vellum/assistants", () => {
      expect(getMultiInstanceDir(prod)).toBe(
        join(TEST_HOME, ".local", "share", "vellum", "assistants"),
      );
    });

    test("dev returns ~/.local/share/vellum-dev/assistants", () => {
      expect(getMultiInstanceDir(dev)).toBe(
        join(TEST_HOME, ".local", "share", "vellum-dev", "assistants"),
      );
    });

    test("respects XDG_DATA_HOME", () => {
      process.env.XDG_DATA_HOME = "/custom/data";
      expect(getMultiInstanceDir(dev)).toBe(
        "/custom/data/vellum-dev/assistants",
      );
    });
  });

  describe("getDefaultPorts", () => {
    test("returns production defaults for production", () => {
      const ports = getDefaultPorts(prod);
      expect(ports.daemon).toBe(7821);
      expect(ports.gateway).toBe(7830);
      expect(ports.qdrant).toBe(6333);
      expect(ports.ces).toBe(8090);
      expect(ports.outboundProxy).toBe(8080);
      expect(ports.tcp).toBe(8765);
    });

    test("returns identical defaults for dev (Phase 5 deferred)", () => {
      expect(getDefaultPorts(dev)).toEqual(getDefaultPorts(prod));
    });

    test("returns identical defaults for staging", () => {
      const staging: EnvironmentDefinition = {
        name: "staging",
        platformUrl: "https://staging-platform.vellum.ai",
      };
      expect(getDefaultPorts(staging)).toEqual(getDefaultPorts(prod));
    });

    test("merges env.portsOverride on top of defaults", () => {
      const env: EnvironmentDefinition = {
        ...dev,
        portsOverride: { daemon: 9999, gateway: 9998 },
      };
      const ports = getDefaultPorts(env);
      expect(ports.daemon).toBe(9999);
      expect(ports.gateway).toBe(9998);
      expect(ports.qdrant).toBe(6333);
      expect(ports.ces).toBe(8090);
    });

    test("returns a fresh object — mutations do not affect future calls", () => {
      const first = getDefaultPorts(prod);
      first.daemon = 1;
      const second = getDefaultPorts(prod);
      expect(second.daemon).toBe(7821);
    });
  });
});
