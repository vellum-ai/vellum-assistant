import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Real temp dirs: the wrapper flow is mostly filesystem behavior, so only the
// Electron, logging and login-shell edges are faked.
const root = mkdtempSync(path.join(tmpdir(), "vellum linux cli "));
const home = path.join(root, "home");
const userData = path.join(root, "userData");

Object.defineProperty(process, "resourcesPath", {
  value: path.join(root, "resources"),
  writable: true,
});

mock.module("electron", () => ({
  app: {
    getPath: () => userData,
    getVersion: () => "1.0.0",
    isPackaged: true,
  },
}));
mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const realOs = await import("node:os");
mock.module("node:os", () => ({ ...realOs, homedir: () => home }));

// Controlled per test. Null mirrors "could not read the login-shell PATH".
let shellPathValue: string | null = "";
let shellPathHits: string[] = [];
const realShellPath = await import("./shell-path");
mock.module("./shell-path", () => ({
  ...realShellPath,
  resolveShellPath: async () => shellPathValue,
  findExecutablesInPath: () => shellPathHits,
}));

const ensureCliInstalled = mock(async () => undefined);
const realCliInstaller = await import("./cli-installer");
mock.module("./cli-installer", () => ({
  ...realCliInstaller,
  ensureCliInstalled,
}));

const { getCliBinPath } = realCliInstaller;
const {
  WRAPPER_MARKER,
  getCliPathInstallState,
  getWrapperDir,
  getWrapperPath,
  installWrapper,
  provisionCliForWrapper,
  readWrapperOwnership,
  uninstallWrapper,
} = await import("./cli-path-installer");

const installRuntime = (): void => {
  mkdirSync(path.dirname(getCliBinPath()), { recursive: true });
  writeFileSync(getCliBinPath(), "#!/bin/sh\n", "utf8");
};

beforeEach(() => {
  shellPathValue = "";
  shellPathHits = [];
  ensureCliInstalled.mockClear();
});

// Each test starts from a bare temp root.
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("installs an executable POSIX wrapper into ~/.local/bin", () => {
  expect(getWrapperDir()).toBe(path.join(home, ".local", "bin"));

  expect(installWrapper({ overwriteForeign: false })).toBe("installed");

  const script = readFileSync(getWrapperPath(), "utf8");
  expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  expect(script).toContain(WRAPPER_MARKER);
  // The wrapper is machine-stable: every machine-specific path is sourced
  // from the locator the app rewrites on launch.
  expect(script).toContain('. "$LOCATOR"');
  expect(script).toContain('exec "$VELLUM_BUN" "$VELLUM_CLI_BIN" "$@"');
  expect(statSync(getWrapperPath()).mode & 0o777).toBe(0o755);
  expect(readWrapperOwnership()).toBe("ours");
});

test("never clobbers a foreign wrapper without confirmation", () => {
  mkdirSync(getWrapperDir(), { recursive: true });
  writeFileSync(getWrapperPath(), "#!/bin/sh\necho other\n", "utf8");

  expect(readWrapperOwnership()).toBe("foreign");
  expect(installWrapper({ overwriteForeign: false })).toBe(
    "needs-overwrite-confirmation",
  );
  expect(readFileSync(getWrapperPath(), "utf8")).toContain("echo other");

  expect(installWrapper({ overwriteForeign: true })).toBe("installed");
  expect(readWrapperOwnership()).toBe("ours");
});

test("treats a dangling symlink as foreign rather than absent", () => {
  mkdirSync(getWrapperDir(), { recursive: true });
  symlinkSync(path.join(root, "gone", "vellum"), getWrapperPath());

  expect(readWrapperOwnership()).toBe("foreign");
  expect(installWrapper({ overwriteForeign: false })).toBe(
    "needs-overwrite-confirmation",
  );
});

test("uninstall removes only a wrapper we own", () => {
  expect(uninstallWrapper()).toBe("absent");

  mkdirSync(getWrapperDir(), { recursive: true });
  writeFileSync(getWrapperPath(), "foreign", "utf8");
  expect(uninstallWrapper()).toBe("not-ours");
  expect(readFileSync(getWrapperPath(), "utf8")).toBe("foreign");

  installWrapper({ overwriteForeign: true });
  expect(uninstallWrapper()).toBe("removed");
  expect(existsSync(getWrapperPath())).toBe(false);
});

test("reports how the wrapper resolves on the login-shell PATH", async () => {
  // A missing or foreign wrapper is classified without probing the shell.
  shellPathValue = null;
  await expect(getCliPathInstallState()).resolves.toEqual({
    kind: "not-installed",
  });
  mkdirSync(getWrapperDir(), { recursive: true });
  writeFileSync(getWrapperPath(), "foreign", "utf8");
  await expect(getCliPathInstallState()).resolves.toEqual({
    kind: "foreign-file",
  });

  // An unreadable login-shell PATH degrades rather than guessing.
  installWrapper({ overwriteForeign: true });
  await expect(getCliPathInstallState()).resolves.toEqual({
    kind: "installed",
    inPath: false,
    runtimeReady: false,
  });

  // An earlier PATH entry wins over the wrapper.
  const shadow = path.join(root, "npm-global", "vellum");
  shellPathValue = `${path.dirname(shadow)}:${getWrapperDir()}`;
  shellPathHits = [shadow];
  await expect(getCliPathInstallState()).resolves.toEqual({
    kind: "shadowed",
    shadowedBy: shadow,
    inPath: true,
    runtimeReady: false,
  });

  // Once the pinned runtime is provisioned the wrapper can actually run.
  shellPathHits = [getWrapperPath()];
  installRuntime();
  await expect(getCliPathInstallState()).resolves.toEqual({
    kind: "installed",
    inPath: true,
    runtimeReady: true,
  });
});

test("self-heals the pinned CLI only for a wrapper we own", async () => {
  await expect(provisionCliForWrapper()).resolves.toBe(false);
  expect(ensureCliInstalled).not.toHaveBeenCalled();

  installWrapper({ overwriteForeign: false });
  await expect(provisionCliForWrapper()).resolves.toBe(true);
  expect(ensureCliInstalled).toHaveBeenCalledTimes(1);
});
