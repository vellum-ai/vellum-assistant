import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionCliRuntime, type CliRuntimePaths } from "./cli-installer";
import {
  getCliLauncherState,
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
  writeFileSync(path.join(dir, "bun.exe"), "bun", "utf8");
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

const registry = (initial = "C:\\Windows\\System32") => {
  let userPath = initial;
  const run: RegistryRunner = (_command, args) => {
    if (args[0] === "QUERY") {
      return `    Path    REG_EXPAND_SZ    ${userPath}\r\n`;
    }
    userPath = args[args.indexOf("/d") + 1];
    return "";
  };
  return { run, value: () => userPath };
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
  const fallback = provisionCliRuntime(runtimePaths(root, "3.0.0"));
  expect(fallback.installDir).toBe(v2.installDir);
  expect(fallback.reused).toBeTrue();
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
  expect(userRegistry.value().split(";")).toContain(paths.binDir);
  rmSync(path.join(collisionDir, "vellum.exe"));
  expect(installCliLauncher(source, "1.0.0", paths, userRegistry.run)).toBe(
    "installed",
  );
  expect(uninstallCliLauncher(paths, userRegistry.run)).toBeTrue();
  expect(userRegistry.value().split(";")).not.toContain(paths.binDir);
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
  expect(readFileSync(paths.bunExecutable, "utf8")).toBe("bun");
  expect(getCliLauncherState(paths, first)).toBe("installed");
});
