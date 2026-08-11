import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionCliRuntime, type CliRuntimePaths } from "./cli-installer";
import {
  getCliLauncherState,
  ensureUserPath,
  installCliLauncher,
  resolveCliLauncherPaths,
  type RegistryRunner,
  uninstallCliLauncher,
} from "./cli-path-installer";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "Vellum Example User 用户 "));
  tempDirs.push(dir);
  return dir;
};

const writeRuntime = (dir: string, version: string): string => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "vellum.exe"), `vellum-${version}`, "utf8");
  writeFileSync(path.join(dir, "bun.exe"), `bun-${version}`, "utf8");
  writeFileSync(
    path.join(dir, "runtime.json"),
    JSON.stringify({ version, bunVersion: "1.3.11" }),
    "utf8",
  );
  return path.join(dir, "vellum.exe");
};

const runtimePaths = (root: string, version: string): CliRuntimePaths => ({
  sourceDir: path.join(root, "resources", "cli-runtime"),
  installRoot: path.join(root, "User Data", "cli"),
  version,
});

const registry = (
  initialUserPath = "C:\\Windows\\System32",
  machinePath = "C:\\Windows\\System32",
) => {
  let userPath = initialUserPath;
  let broadcastCount = 0;
  const run: RegistryRunner = (command, args) => {
    if (command === "powershell.exe") {
      broadcastCount += 1;
      return "";
    }
    if (args[0] === "QUERY") {
      const value = args[1].startsWith("HKLM") ? machinePath : userPath;
      return `    Path    REG_EXPAND_SZ    ${value}\r\n`;
    }
    userPath = args[args.indexOf("/d") + 1];
    return "";
  };
  return {
    broadcasts: () => broadcastCount,
    run,
    value: () => userPath,
  };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installs, upgrades, and falls back from paths with spaces", () => {
  const root = makeTempDir();
  const first = runtimePaths(root, "1.0.0");
  writeRuntime(first.sourceDir, first.version);
  const v1 = provisionCliRuntime(first);
  expect(readFileSync(path.join(v1.installDir, "vellum.exe"), "utf8")).toBe(
    "vellum-1.0.0",
  );

  rmSync(first.sourceDir, { recursive: true });
  const second = runtimePaths(root, "2.0.0");
  writeRuntime(second.sourceDir, second.version);
  const v2 = provisionCliRuntime(second);
  expect(v2.previousInstallDir).toBe(v1.installDir);
  expect(v2.reused).toBeFalse();
  rmSync(second.sourceDir, { recursive: true });
  rmSync(path.join(v2.installDir, "vellum.exe"));
  const fallback = provisionCliRuntime(runtimePaths(root, "3.0.0"));
  expect(fallback.installDir).toBe(v1.installDir);
  expect(fallback.reused).toBeTrue();
});

test("preserves the newer runtime when reusing an older version", () => {
  const root = makeTempDir();
  const first = runtimePaths(root, "1.0.0");
  writeRuntime(first.sourceDir, first.version);
  const v1 = provisionCliRuntime(first);

  rmSync(first.sourceDir, { recursive: true });
  const second = runtimePaths(root, "2.0.0");
  writeRuntime(second.sourceDir, second.version);
  const v2 = provisionCliRuntime(second);

  const rollback = provisionCliRuntime(first);
  expect(rollback.installDir).toBe(v1.installDir);
  expect(rollback.previousInstallDir).toBe(v2.installDir);

  rmSync(second.sourceDir, { recursive: true });
  rmSync(path.join(v1.installDir, "vellum.exe"));
  const fallback = provisionCliRuntime(runtimePaths(root, "3.0.0"));
  expect(fallback.installDir).toBe(v2.installDir);
});

test("does not replace a foreign launcher", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.executable, "foreign", "utf8");
  const source = path.join(root, "vellum.exe");
  writeFileSync(source, "owned", "utf8");

  expect(installCliLauncher(source, "1.0.0", paths, registry().run)).toBe(
    "foreign",
  );
  expect(readFileSync(paths.executable, "utf8")).toBe("foreign");
});

test("repairs stale ownership and updates the user PATH", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(
    paths.ownership,
    JSON.stringify({ sourcePath: "missing.exe", version: "0.9.0" }),
    "utf8",
  );
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const collisionDir = path.join(root, "Existing CLI");
  mkdirSync(collisionDir, { recursive: true });
  writeFileSync(path.join(collisionDir, "vellum.exe"), "foreign", "utf8");
  const userRegistry = registry(collisionDir);

  expect(getCliLauncherState(paths, source)).toBe("stale");
  expect(installCliLauncher(source, "1.0.0", paths, userRegistry.run)).toBe(
    "shadowed",
  );
  expect(userRegistry.broadcasts()).toBe(1);
  expect(userRegistry.value().split(";")).toContain(paths.binDir);
  rmSync(path.join(collisionDir, "vellum.exe"));
  expect(installCliLauncher(source, "1.0.0", paths, userRegistry.run)).toBe(
    "installed",
  );
  expect(uninstallCliLauncher(paths, userRegistry.run)).toBeTrue();
  expect(userRegistry.broadcasts()).toBe(2);
  expect(userRegistry.value().split(";")).not.toContain(paths.binDir);
});

test("reports a launcher shadowed by the machine PATH", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const collisionDir = path.join(root, "Machine CLI");
  mkdirSync(collisionDir, { recursive: true });
  writeFileSync(path.join(collisionDir, "vellum.exe"), "foreign", "utf8");

  expect(
    installCliLauncher(source, "1.0.0", paths, registry("", collisionDir).run),
  ).toBe("shadowed");
});

test("expands and unquotes PATH entries before collision checks", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const collisionDir = path.join(root, "Expanded Machine CLI");
  mkdirSync(collisionDir, { recursive: true });
  writeFileSync(path.join(collisionDir, "vellum.exe"), "foreign", "utf8");
  process.env.VELLUM_TEST_COLLISION_DIR = collisionDir;

  try {
    expect(
      installCliLauncher(
        source,
        "1.0.0",
        paths,
        registry("", '"%VELLUM_TEST_COLLISION_DIR%"').run,
      ),
    ).toBe("shadowed");
  } finally {
    delete process.env.VELLUM_TEST_COLLISION_DIR;
  }
});

test("treats Windows PATH entries as case-insensitive", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const registeredBinDir = paths.binDir.toUpperCase();
  const userRegistry = registry(registeredBinDir);

  expect(installCliLauncher(source, "1.0.0", paths, userRegistry.run)).toBe(
    "installed",
  );
  expect(userRegistry.broadcasts()).toBe(0);
  expect(userRegistry.value()).toBe(registeredBinDir);
});

test("restores the last launcher when PATH registration fails", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const first = writeRuntime(path.join(root, "v1"), "v1");
  const second = writeRuntime(path.join(root, "v2"), "v2");
  installCliLauncher(first, "1.0.0", paths, registry().run);
  const failingRegistry: RegistryRunner = (_command, args) => {
    if (args[0] === "QUERY") {
      return "";
    }
    throw new Error("registry unavailable");
  };

  expect(() =>
    installCliLauncher(second, "2.0.0", paths, failingRegistry),
  ).toThrow("registry unavailable");
  expect(readFileSync(paths.executable, "utf8")).toBe("vellum-v1");
  expect(readFileSync(paths.bunExecutable, "utf8")).toBe("bun-v1");
  expect(getCliLauncherState(paths, first)).toBe("installed");
  const malformed: RegistryRunner = () => "Path REG_EXPAND_SZ";
  expect(() => ensureUserPath("C:\\Vellum", malformed)).toThrow(
    "Unable to read the Windows user PATH",
  );
});

test("restores PATH when effective PATH validation fails", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const originalUserPath = "C:\\Windows\\System32";
  let userPath = originalUserPath;
  const run: RegistryRunner = (command, args) => {
    if (command === "powershell.exe") {
      return "";
    }
    if (args[0] === "QUERY") {
      if (args[1].startsWith("HKLM")) {
        throw new Error("machine PATH unavailable");
      }
      return `    Path    REG_EXPAND_SZ    ${userPath}\r\n`;
    }
    userPath = args[args.indexOf("/d") + 1];
    return "";
  };

  expect(() => installCliLauncher(source, "1.0.0", paths, run)).toThrow(
    "Unable to read the effective Windows PATH",
  );
  expect(userPath).toBe(originalUserPath);
  expect(getCliLauncherState(paths, source)).toBe("missing");
});

test("restores earlier launchers when a later executable is locked", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const first = writeRuntime(path.join(root, "v1"), "v1");
  const second = writeRuntime(path.join(root, "v2"), "v2");
  const userRegistry = registry();
  installCliLauncher(first, "1.0.0", paths, userRegistry.run);
  const bunStaging = `${paths.bunExecutable}.${process.pid}.tmp`;
  const failLockedBun: typeof renameSync = (source, target) => {
    if (source === bunStaging && target === paths.bunExecutable) {
      throw new Error("bun.exe is locked");
    }
    renameSync(source, target);
  };

  expect(() =>
    installCliLauncher(second, "2.0.0", paths, userRegistry.run, {
      renameFile: failLockedBun,
    }),
  ).toThrow("bun.exe is locked");
  expect(readFileSync(paths.executable, "utf8")).toBe("vellum-v1");
  expect(readFileSync(paths.bunExecutable, "utf8")).toBe("bun-v1");
  expect(getCliLauncherState(paths, first)).toBe("installed");
});

test("keeps installed launchers when backup cleanup is blocked", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const first = writeRuntime(path.join(root, "v1"), "v1");
  const second = writeRuntime(path.join(root, "v2"), "v2");
  const userRegistry = registry();
  installCliLauncher(first, "1.0.0", paths, userRegistry.run);
  const lockedBackup = `${paths.executable}.${process.pid}.backup`;
  const removeUnlockedBackup: typeof rmSync = (target, options) => {
    if (target === lockedBackup) {
      throw new Error("backup is locked");
    }
    rmSync(target, options);
  };

  expect(
    installCliLauncher(second, "2.0.0", paths, userRegistry.run, {
      removeBackupFile: removeUnlockedBackup,
    }),
  ).toBe("installed");
  expect(readFileSync(paths.executable, "utf8")).toBe("vellum-v2");
  expect(readFileSync(paths.bunExecutable, "utf8")).toBe("bun-v2");
  expect(getCliLauncherState(paths, second)).toBe("installed");
});
