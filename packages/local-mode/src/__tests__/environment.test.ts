import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultEnvironmentFilePath,
  readDefaultEnvironment,
  resolveEnvironmentName,
} from "../environment";
import { resolveLockfilePaths, resolveConfigDir } from "../config";

let configHome: string;

/** Write the persisted default-environment file under the temp config home. */
function persistDefault(name: string): void {
  const file = path.join(configHome, "vellum", "environment");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, name + "\n", "utf-8");
}

beforeEach(() => {
  configHome = mkdtempSync(path.join(os.tmpdir(), "vellum-env-"));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

describe("defaultEnvironmentFilePath", () => {
  test("honors XDG_CONFIG_HOME", () => {
    expect(defaultEnvironmentFilePath({ XDG_CONFIG_HOME: configHome })).toBe(
      path.join(configHome, "vellum", "environment"),
    );
  });

  test("falls back to ~/.config", () => {
    expect(defaultEnvironmentFilePath({})).toBe(
      path.join(os.homedir(), ".config", "vellum", "environment"),
    );
  });
});

describe("readDefaultEnvironment", () => {
  test("returns undefined when no file exists", () => {
    expect(
      readDefaultEnvironment({ XDG_CONFIG_HOME: configHome }),
    ).toBeUndefined();
  });

  test("returns the trimmed persisted name", () => {
    persistDefault("dev");
    expect(readDefaultEnvironment({ XDG_CONFIG_HOME: configHome })).toBe("dev");
  });

  test("treats an empty file as no default", () => {
    const file = path.join(configHome, "vellum", "environment");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "  \n", "utf-8");
    expect(
      readDefaultEnvironment({ XDG_CONFIG_HOME: configHome }),
    ).toBeUndefined();
  });
});

describe("resolveEnvironmentName", () => {
  test("prefers VELLUM_ENVIRONMENT over the persisted default", () => {
    persistDefault("dev");
    expect(
      resolveEnvironmentName({
        XDG_CONFIG_HOME: configHome,
        VELLUM_ENVIRONMENT: "staging",
      }),
    ).toBe("staging");
  });

  test("falls back to the persisted default when the env var is unset", () => {
    persistDefault("dev");
    expect(resolveEnvironmentName({ XDG_CONFIG_HOME: configHome })).toBe("dev");
  });

  test("falls back to production when neither is set", () => {
    expect(resolveEnvironmentName({ XDG_CONFIG_HOME: configHome })).toBe(
      "production",
    );
  });
});

describe("path resolvers honor the persisted default", () => {
  test("resolveLockfilePaths points at the persisted environment", () => {
    persistDefault("dev");
    const env = { XDG_CONFIG_HOME: configHome };
    expect(resolveLockfilePaths(env)).toEqual([
      path.join(configHome, "vellum-dev", "lockfile.json"),
    ]);
  });

  test("resolveConfigDir points at the persisted environment", () => {
    persistDefault("dev");
    expect(resolveConfigDir({ XDG_CONFIG_HOME: configHome })).toBe(
      path.join(configHome, "vellum-dev"),
    );
  });

  test("VELLUM_ENVIRONMENT still wins for path resolution", () => {
    persistDefault("dev");
    const env = {
      XDG_CONFIG_HOME: configHome,
      VELLUM_ENVIRONMENT: "production",
    };
    expect(resolveLockfilePaths(env)).toEqual([
      path.join(os.homedir(), ".vellum.lock.json"),
      path.join(os.homedir(), ".vellum.lockfile.json"),
    ]);
  });
});
