import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLI_RUNTIME_ASSETS,
  CLI_RUNTIME_ENTRIES,
  CLI_RUNTIME_EXECUTABLES,
  CLI_RUNTIME_OWNERSHIP_MARKER,
  isValidCliRuntime,
  provisionCliRuntime,
  readRuntimeManifest,
  type CliRuntimePaths,
} from "./cli-installer";
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

const writeRuntimeEntries = (dir: string, version: string): void => {
  mkdirSync(dir, { recursive: true });
  for (const name of CLI_RUNTIME_EXECUTABLES) {
    const contents = name === "vellum.exe" ? `vellum-${version}` : name;
    writeFileSync(path.join(dir, name), contents, "utf8");
  }
  for (const name of CLI_RUNTIME_ASSETS) {
    const target = path.join(dir, name);
    if (name.endsWith(".wasm") || name.endsWith(".json")) {
      writeFileSync(target, name, "utf8");
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "fixture.txt"), name, "utf8");
    }
  }
};

const writeRuntime = (
  dir: string,
  version: string,
  runtimeBuildId = `build-${version}`,
): string => {
  writeRuntimeEntries(dir, version);
  writeFileSync(
    path.join(dir, "runtime.json"),
    JSON.stringify({ version, bunVersion: "1.3.11", runtimeBuildId }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, CLI_RUNTIME_OWNERSHIP_MARKER),
    JSON.stringify({ owner: "vellum-assistant", version }),
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

const readLauncherSource = (ownershipPath: string): string =>
  (JSON.parse(readFileSync(ownershipPath, "utf8")) as { sourcePath: string })
    .sourcePath;

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

test("prunes only owned runtimes older than the fallback", () => {
  const root = makeTempDir();
  let previousInstallDir: string | undefined;
  const installDirs: string[] = [];

  for (const [version, buildChar] of [
    ["1.0.0", "1"],
    ["2.0.0", "2"],
    ["3.0.0", "3"],
  ] as const) {
    const paths = runtimePaths(root, version);
    rmSync(paths.sourceDir, { recursive: true, force: true });
    writeRuntime(paths.sourceDir, version, buildChar.repeat(64));
    const result = provisionCliRuntime(paths);
    installDirs.push(result.installDir);
    previousInstallDir = result.previousInstallDir;
  }

  const installRoot = runtimePaths(root, "3.0.0").installRoot;
  expect(existsSync(installDirs[0]!)).toBeFalse();
  expect(existsSync(installDirs[1]!)).toBeTrue();
  expect(existsSync(installDirs[2]!)).toBeTrue();
  expect(previousInstallDir).toBe(installDirs[1]);

  const foreign = path.join(installRoot, "foreign");
  writeRuntime(foreign, "foreign");
  rmSync(path.join(foreign, CLI_RUNTIME_OWNERSHIP_MARKER));
  const fourth = runtimePaths(root, "4.0.0");
  rmSync(fourth.sourceDir, { recursive: true, force: true });
  writeRuntime(fourth.sourceDir, fourth.version);
  provisionCliRuntime(fourth);
  expect(existsSync(foreign)).toBeTrue();
});

test("does not trust fallback paths outside the install root", () => {
  const root = makeTempDir();
  const paths = runtimePaths(root, "2.0.0");
  const outside = path.join(root, "outside-runtime");
  writeRuntime(outside, "1.0.0");
  mkdirSync(paths.installRoot, { recursive: true });
  writeFileSync(
    path.join(paths.installRoot, "install-state.json"),
    JSON.stringify({ currentInstallDir: outside }),
    "utf8",
  );

  expect(() => provisionCliRuntime(paths)).toThrow(
    "The packaged Windows CLI runtime is missing or invalid.",
  );
  expect(existsSync(outside)).toBeTrue();
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

test("installs a changed same-version runtime side by side", () => {
  const root = makeTempDir();
  const paths = runtimePaths(root, "1.0.0");
  const firstBuildId = "1".repeat(64);
  const secondBuildId = "2".repeat(64);
  writeRuntime(paths.sourceDir, paths.version, firstBuildId);
  const first = provisionCliRuntime(paths);

  rmSync(paths.sourceDir, { recursive: true });
  writeRuntime(paths.sourceDir, paths.version, secondBuildId);
  const replacement = provisionCliRuntime(paths);

  expect(replacement.installDir).not.toBe(first.installDir);
  expect(replacement.previousInstallDir).toBe(first.installDir);
  expect(existsSync(first.installDir)).toBeTrue();
  expect(replacement.reused).toBeFalse();
  expect(readRuntimeManifest(replacement.installDir)?.runtimeBuildId).toBe(
    secondBuildId,
  );
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

test("isolates non-production launchers from the production PATH entry", () => {
  const localAppData = path.join(makeTempDir(), "Local App Data");
  const production = resolveCliLauncherPaths(localAppData);
  const staging = resolveCliLauncherPaths(localAppData, "staging");
  const development = resolveCliLauncherPaths(localAppData, "development");

  expect(production.binDir).toBe(path.join(localAppData, "Vellum", "bin"));
  expect(staging.binDir).toBe(path.join(localAppData, "Vellum-staging", "bin"));
  expect(development.binDir).not.toBe(staging.binDir);
  expect(development.binDir).not.toBe(production.binDir);
});

test("reuses an unchanged launcher without replacing its executables", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  installCliLauncher(source, "1.0.0", paths, userRegistry.run);
  const repairedRegistry = registry();

  const rejectReplacement: typeof renameSync = () => {
    throw new Error("unchanged launchers must not be replaced");
  };
  expect(
    installCliLauncher(source, "1.0.0", paths, repairedRegistry.run, {
      renameFile: rejectReplacement,
    }),
  ).toBe("installed");
  expect(repairedRegistry.broadcasts()).toBe(1);
  expect(repairedRegistry.value().split(";")).toContain(paths.binDir);
  expect(readFileSync(paths.executable, "utf8")).toBe("cli-launcher.exe");
  expect(readLauncherSource(paths.ownership)).toBe(source);
});

test("refreshes ownership without replacing an unchanged launcher", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  const firstOwner = path.join(root, "First Install", "resources");
  const secondOwner = path.join(root, "Second Install", "resources");
  installCliLauncher(source, "1.0.0", paths, userRegistry.run, {
    ownerId: firstOwner,
  });

  const rejectLauncherReplacement: typeof renameSync = (from, to) => {
    if (from === paths.executable || to === paths.executable) {
      throw new Error("unchanged launcher must not be replaced");
    }
    renameSync(from, to);
  };
  expect(
    installCliLauncher(source, "1.0.0", paths, userRegistry.run, {
      ownerId: secondOwner,
      renameFile: rejectLauncherReplacement,
    }),
  ).toBe("installed");
  expect(uninstallCliLauncher(paths, userRegistry.run, firstOwner)).toBe(
    "not-owned",
  );
  expect(uninstallCliLauncher(paths, userRegistry.run, secondOwner)).toBe(
    "removed",
  );
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
  expect(uninstallCliLauncher(paths, userRegistry.run)).toBe("removed");
  expect(userRegistry.broadcasts()).toBe(2);
  expect(userRegistry.value().split(";")).not.toContain(paths.binDir);
  expect(getCliLauncherState(paths, source)).toBe("missing");
});

test("requires every packaged entry but puts only the launcher on PATH", () => {
  const root = makeTempDir();
  const runtimeDir = path.join(root, "runtime");
  const source = writeRuntime(runtimeDir, "1.0.0");
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const userRegistry = registry();

  for (const name of CLI_RUNTIME_ENTRIES) {
    rmSync(path.join(runtimeDir, name), { recursive: true });
    expect(isValidCliRuntime(runtimeDir, "1.0.0")).toBeFalse();
    writeRuntime(runtimeDir, "1.0.0");
  }

  writeRuntimeEntries(paths.binDir, "legacy");
  writeFileSync(
    paths.ownership,
    JSON.stringify({ sourcePath: source, version: "0.9.0" }),
    "utf8",
  );
  installCliLauncher(source, "1.0.0", paths, userRegistry.run);
  expect(readFileSync(paths.executable, "utf8")).toBe("cli-launcher.exe");
  expect(readLauncherSource(paths.ownership)).toBe(source);
  expect(
    CLI_RUNTIME_ENTRIES.filter((name) => name !== "vellum.exe").every(
      (name) => !existsSync(path.join(paths.binDir, name)),
    ),
  ).toBeTrue();
  expect(uninstallCliLauncher(paths, userRegistry.run)).toBe("removed");
  expect(existsSync(paths.executable)).toBeFalse();
});

test("preserves a launcher owned by another installed environment", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  const productionResources = path.join(root, "Vellum", "resources");
  const stagingResources = path.join(root, "Vellum Staging", "resources");

  installCliLauncher(source, "1.0.0", paths, userRegistry.run, {
    ownerId: stagingResources,
  });
  expect(
    uninstallCliLauncher(paths, userRegistry.run, productionResources),
  ).toBe("not-owned");
  expect(getCliLauncherState(paths, source, userRegistry.value())).toBe(
    "installed",
  );
  expect(uninstallCliLauncher(paths, userRegistry.run, stagingResources)).toBe(
    "removed",
  );
});

test("removes a launcher with legacy ownership metadata", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry(paths.binDir);
  const legacyBun = path.join(paths.binDir, "bun.exe");
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.executable, "legacy vellum", "utf8");
  writeFileSync(legacyBun, "legacy bun", "utf8");
  writeFileSync(
    paths.ownership,
    JSON.stringify({ sourcePath: source, version: "1.0.0" }),
    "utf8",
  );

  expect(
    uninstallCliLauncher(paths, userRegistry.run, path.join(root, "resources")),
  ).toBe("removed");
  expect(existsSync(paths.executable)).toBeFalse();
  expect(existsSync(legacyBun)).toBeFalse();
  expect(existsSync(paths.ownership)).toBeFalse();
  expect(userRegistry.value().split(";")).not.toContain(paths.binDir);
});

test("requires an owner ID for current launcher metadata", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  installCliLauncher(source, "1.0.0", paths, userRegistry.run);

  expect(
    uninstallCliLauncher(paths, userRegistry.run, path.join(root, "resources")),
  ).toBe("not-owned");
  expect(existsSync(paths.executable)).toBeTrue();
  expect(existsSync(paths.ownership)).toBeTrue();
  expect(userRegistry.value().split(";")).toContain(paths.binDir);
});

test("skips missing and foreign launchers during uninstall", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const failRegistry: RegistryRunner = () => {
    throw new Error("registry should not be read");
  };

  expect(uninstallCliLauncher(paths, failRegistry)).toBe("not-owned");

  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.executable, "foreign", "utf8");
  expect(uninstallCliLauncher(paths, failRegistry)).toBe("not-owned");
  expect(readFileSync(paths.executable, "utf8")).toBe("foreign");
});

test("restores owned entries when uninstall cannot update PATH", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  installCliLauncher(source, "1.0.0", paths, userRegistry.run);
  const failingRegistry: RegistryRunner = (_command, args) => {
    if (args[0] === "QUERY") {
      return `    Path    REG_EXPAND_SZ    ${userRegistry.value()}\r\n`;
    }
    throw new Error("registry unavailable");
  };

  expect(() => uninstallCliLauncher(paths, failingRegistry)).toThrow(
    "registry unavailable",
  );
  expect(existsSync(paths.executable)).toBeTrue();
  expect(existsSync(paths.ownership)).toBeTrue();
  expect(userRegistry.value().split(";")).toContain(paths.binDir);
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

test("treats launcher source paths as case-insensitive", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  installCliLauncher(source, "1.0.0", paths, registry().run);
  const ownership = JSON.parse(readFileSync(paths.ownership, "utf8")) as {
    sourcePath: string;
  };
  writeFileSync(
    paths.ownership,
    JSON.stringify({ ...ownership, sourcePath: source.toUpperCase() }),
    "utf8",
  );

  expect(getCliLauncherState(paths, source)).toBe("installed");
});

test("retries cleanup of a staged launcher", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const source = writeRuntime(path.join(root, "runtime"), "1.0.0");
  const userRegistry = registry();
  installCliLauncher(source, "1.0.0", paths, userRegistry.run);
  const stagedLauncher = path.join(paths.binDir, ".vellum.exe.uninstalling");
  renameSync(paths.executable, stagedLauncher);
  const retryRegistry = registry();

  expect(uninstallCliLauncher(paths, retryRegistry.run)).toBe("removed");
  expect(existsSync(stagedLauncher)).toBeFalse();
  expect(existsSync(paths.ownership)).toBeFalse();
  expect(retryRegistry.broadcasts()).toBe(0);
  expect(retryRegistry.value().split(";")).not.toContain(paths.binDir);
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
  expect(readLauncherSource(paths.ownership)).toBe(first);
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

test("restores the launcher when ownership replacement is locked", () => {
  const root = makeTempDir();
  const paths = resolveCliLauncherPaths(path.join(root, "Local App Data"));
  const first = writeRuntime(path.join(root, "v1"), "v1");
  const second = writeRuntime(path.join(root, "v2"), "v2");
  const userRegistry = registry();
  installCliLauncher(first, "1.0.0", paths, userRegistry.run);
  const ownershipStaging = `${paths.ownership}.${process.pid}.tmp`;
  const failLockedOwnership: typeof renameSync = (source, target) => {
    if (source === ownershipStaging && target === paths.ownership) {
      throw new Error("ownership is locked");
    }
    renameSync(source, target);
  };

  expect(() =>
    installCliLauncher(second, "2.0.0", paths, userRegistry.run, {
      renameFile: failLockedOwnership,
    }),
  ).toThrow("ownership is locked");
  expect(readLauncherSource(paths.ownership)).toBe(first);
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
  expect(readFileSync(paths.executable, "utf8")).toBe("cli-launcher.exe");
  expect(readLauncherSource(paths.ownership)).toBe(second);
  expect(getCliLauncherState(paths, second)).toBe("installed");
});
