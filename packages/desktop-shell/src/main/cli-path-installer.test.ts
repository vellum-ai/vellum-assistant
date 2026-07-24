import { afterEach, describe, expect, mock, test } from "bun:test";

// --- Mocks ---
// Must be installed before the `await import` of the module under test so
// the mocked module graph is in place when `cli-path-installer.ts` (and its
// `cli-installer.ts` dependency) is evaluated. See `cli-installer.test.ts`.

const userDataPath = "/mock/userData";
const mockResourcesPath = "/mock/resources";
const mockHome = "/mock/home";

// `process.resourcesPath` is only defined inside a packaged Electron app.
Object.defineProperty(process, "resourcesPath", {
  value: mockResourcesPath,
  writable: true,
});

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return userDataPath;
      return "/tmp";
    },
    isPackaged: true,
  },
}));

mock.module("./logger", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => mockHome,
}));

// Track fs calls so tests can assert on them.
let readFileSyncResult: string | Error | null = null;
// Drives isCliInstalled() (existsSync on the CLI bin path) → runtimeReady.
let cliBinExists = false;
// "auto" mirrors readFileSync presence; "exists" forces a present entry
// (e.g. a dangling symlink whose readFileSync still throws ENOENT).
let lstatSyncBehavior: "auto" | "exists" = "auto";
// Symlink resolution map; paths not present throw (like realpathSync).
const realpathMap: Record<string, string> = {};
const mkdirSyncCalls: Array<[string, object]> = [];
const writeFileSyncCalls: Array<[string, string]> = [];
const chmodSyncCalls: Array<[string, number]> = [];
const renameSyncCalls: Array<[string, string]> = [];
const rmSyncCalls: Array<[string, object]> = [];

const enoent = () => {
  const err = new Error("ENOENT: no such file or directory");
  (err as NodeJS.ErrnoException).code = "ENOENT";
  return err;
};

mock.module("node:fs", () => ({
  // Used by the cli-installer and shell-path modules evaluated as deps.
  accessSync: () => {},
  statSync: () => ({ isFile: () => true }),
  constants: { X_OK: 1 },
  copyFileSync: () => {},
  existsSync: () => cliBinExists,
  readdirSync: () => [],
  // Used by cli-path-installer.
  chmodSync: (p: string, mode: number) => {
    chmodSyncCalls.push([p, mode]);
  },
  lstatSync: (_p: string) => {
    if (lstatSyncBehavior === "exists") return {};
    if (readFileSyncResult === null) throw enoent();
    return {};
  },
  mkdirSync: (p: string, opts: object) => {
    mkdirSyncCalls.push([p, opts]);
  },
  readFileSync: (_p: string, _enc?: string) => {
    if (readFileSyncResult === null) throw enoent();
    if (readFileSyncResult instanceof Error) throw readFileSyncResult;
    return readFileSyncResult;
  },
  realpathSync: (p: string) => {
    const resolved = realpathMap[p];
    if (resolved === undefined) throw enoent();
    return resolved;
  },
  renameSync: (src: string, dst: string) => {
    renameSyncCalls.push([src, dst]);
  },
  rmSync: (p: string, opts: object) => {
    rmSyncCalls.push([p, opts]);
  },
  writeFileSync: (p: string, content: string) => {
    writeFileSyncCalls.push([p, content]);
  },
}));

// Controlled per-test; reset in afterEach. Null mirrors "could not
// reliably determine the login-shell PATH".
let shellPathValue: string | null = "";
let shellPathHits: string[] = [];
let resolveShellPathCalls = 0;
const findExecutablesCalls: Array<[string, string]> = [];

// Spread the real module so `splitPathEntries` keeps its production
// behavior; only the spawning/probing functions are faked.
const realShellPath = await import("./shell-path");
mock.module("./shell-path", () => ({
  ...realShellPath,
  resolveShellPath: async () => {
    resolveShellPathCalls += 1;
    return shellPathValue;
  },
  findExecutablesInPath: (name: string, pathValue: string) => {
    findExecutablesCalls.push([name, pathValue]);
    return shellPathHits;
  },
}));

// Spread the real module so path/quote/locator helpers keep production
// behavior; only the install entry point is faked.
const ensureCliInstalledMock = mock(async (): Promise<void> => undefined);
const realCliInstaller = await import("./cli-installer");
mock.module("./cli-installer", () => ({
  ...realCliInstaller,
  ensureCliInstalled: ensureCliInstalledMock,
}));

const {
  WRAPPER_MARKER,
  getWrapperDir,
  getWrapperPath,
  buildWrapperScript,
  readWrapperOwnership,
  installWrapper,
  uninstallWrapper,
  getCliPathInstallState,
  provisionCliForWrapper,
} = await import("./cli-path-installer");

const wrapperDir = `${mockHome}/.local/bin`;
const wrapperPath = `${wrapperDir}/vellum`;
const locatorPath = `${userDataPath}/cli/locator.sh`;

afterEach(() => {
  readFileSyncResult = null;
  cliBinExists = false;
  lstatSyncBehavior = "auto";
  for (const key of Object.keys(realpathMap)) delete realpathMap[key];
  mkdirSyncCalls.length = 0;
  writeFileSyncCalls.length = 0;
  chmodSyncCalls.length = 0;
  renameSyncCalls.length = 0;
  rmSyncCalls.length = 0;
  shellPathValue = "";
  shellPathHits = [];
  resolveShellPathCalls = 0;
  findExecutablesCalls.length = 0;
  ensureCliInstalledMock.mockClear();
});

// --- Path helpers ---

describe("getWrapperDir", () => {
  test("returns ~/.local/bin", () => {
    expect(getWrapperDir()).toBe(wrapperDir);
  });
});

describe("getWrapperPath", () => {
  test("returns ~/.local/bin/vellum", () => {
    expect(getWrapperPath()).toBe(wrapperPath);
  });
});

// --- buildWrapperScript ---

describe("buildWrapperScript", () => {
  test("starts with a POSIX sh shebang", () => {
    expect(buildWrapperScript().startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("contains the ownership marker", () => {
    expect(buildWrapperScript()).toContain(`${WRAPPER_MARKER}\n`);
  });

  test("embeds the single-quoted locator path", () => {
    expect(buildWrapperScript()).toContain(`LOCATOR='${locatorPath}'\n`);
  });

  test("ends with the exec line", () => {
    expect(buildWrapperScript().endsWith('exec "$VELLUM_BUN" "$VELLUM_CLI_BIN" "$@"\n')).toBe(
      true,
    );
  });
});

// --- readWrapperOwnership ---

describe("readWrapperOwnership", () => {
  test("returns absent when no file exists at the wrapper path", () => {
    readFileSyncResult = null; // lstatSync and readFileSync throw ENOENT
    expect(readWrapperOwnership()).toBe("absent");
  });

  test("returns ours when the file contains the marker", () => {
    readFileSyncResult = buildWrapperScript();
    expect(readWrapperOwnership()).toBe("ours");
  });

  test("returns ours for an older wrapper revision containing the marker", () => {
    readFileSyncResult = `#!/bin/sh\n${WRAPPER_MARKER}\n# old body\nexit 0\n`;
    expect(readWrapperOwnership()).toBe("ours");
  });

  test("returns foreign for a file without the marker", () => {
    readFileSyncResult = "#!/bin/sh\necho some other vellum tool\n";
    expect(readWrapperOwnership()).toBe("foreign");
  });

  test("returns foreign when the file exists but is unreadable", () => {
    const eacces = new Error("EACCES: permission denied");
    (eacces as NodeJS.ErrnoException).code = "EACCES";
    readFileSyncResult = eacces;
    expect(readWrapperOwnership()).toBe("foreign");
  });

  test("returns foreign for a dangling symlink (lstat exists, read ENOENT)", () => {
    lstatSyncBehavior = "exists";
    readFileSyncResult = null; // readFileSync follows the link → ENOENT

    expect(readWrapperOwnership()).toBe("foreign");
  });
});

// --- installWrapper ---

describe("installWrapper", () => {
  test("creates ~/.local/bin and atomically writes a 0755 wrapper", () => {
    readFileSyncResult = null; // absent

    const result = installWrapper({ overwriteForeign: false });

    expect(result).toBe("installed");
    expect(mkdirSyncCalls).toEqual([[wrapperDir, { recursive: true }]]);
    expect(writeFileSyncCalls).toEqual([
      [`${wrapperPath}.tmp`, buildWrapperScript()],
    ]);
    expect(chmodSyncCalls).toEqual([[`${wrapperPath}.tmp`, 0o755]]);
    expect(renameSyncCalls).toEqual([[`${wrapperPath}.tmp`, wrapperPath]]);
  });

  test("returns needs-overwrite-confirmation for a foreign file without touching the fs", () => {
    readFileSyncResult = "#!/bin/sh\necho not ours\n";

    const result = installWrapper({ overwriteForeign: false });

    expect(result).toBe("needs-overwrite-confirmation");
    expect(mkdirSyncCalls).toHaveLength(0);
    expect(writeFileSyncCalls).toHaveLength(0);
    expect(chmodSyncCalls).toHaveLength(0);
    expect(renameSyncCalls).toHaveLength(0);
  });

  test("requires confirmation for a dangling foreign symlink instead of clobbering it", () => {
    lstatSyncBehavior = "exists";
    readFileSyncResult = null;

    const result = installWrapper({ overwriteForeign: false });

    expect(result).toBe("needs-overwrite-confirmation");
    expect(writeFileSyncCalls).toHaveLength(0);
    expect(renameSyncCalls).toHaveLength(0);
  });

  test("overwrites a foreign file when overwriteForeign is true", () => {
    readFileSyncResult = "#!/bin/sh\necho not ours\n";

    const result = installWrapper({ overwriteForeign: true });

    expect(result).toBe("installed");
    expect(writeFileSyncCalls).toEqual([
      [`${wrapperPath}.tmp`, buildWrapperScript()],
    ]);
    expect(renameSyncCalls).toEqual([[`${wrapperPath}.tmp`, wrapperPath]]);
  });

  test("overwrites our own older wrapper without confirmation", () => {
    readFileSyncResult = `#!/bin/sh\n${WRAPPER_MARKER}\n# stale body\n`;

    const result = installWrapper({ overwriteForeign: false });

    expect(result).toBe("installed");
    expect(writeFileSyncCalls).toEqual([
      [`${wrapperPath}.tmp`, buildWrapperScript()],
    ]);
    expect(renameSyncCalls).toEqual([[`${wrapperPath}.tmp`, wrapperPath]]);
  });
});

// --- uninstallWrapper ---

describe("uninstallWrapper", () => {
  test("removes the wrapper when it is ours", () => {
    readFileSyncResult = buildWrapperScript();

    expect(uninstallWrapper()).toBe("removed");
    expect(rmSyncCalls).toEqual([[wrapperPath, { force: true }]]);
  });

  test("refuses to delete a foreign file", () => {
    readFileSyncResult = "#!/bin/sh\necho not ours\n";

    expect(uninstallWrapper()).toBe("not-ours");
    expect(rmSyncCalls).toHaveLength(0);
  });

  test("refuses to delete a dangling foreign symlink", () => {
    lstatSyncBehavior = "exists";
    readFileSyncResult = null;

    expect(uninstallWrapper()).toBe("not-ours");
    expect(rmSyncCalls).toHaveLength(0);
  });

  test("no-ops when the wrapper is absent", () => {
    readFileSyncResult = null;

    expect(uninstallWrapper()).toBe("absent");
    expect(rmSyncCalls).toHaveLength(0);
  });
});

// --- provisionCliForWrapper ---

describe("provisionCliForWrapper", () => {
  test("provisions the CLI when the wrapper is ours", async () => {
    readFileSyncResult = buildWrapperScript();

    expect(await provisionCliForWrapper()).toBe(true);
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("skips provisioning when the wrapper is absent", async () => {
    readFileSyncResult = null;

    expect(await provisionCliForWrapper()).toBe(false);
    expect(ensureCliInstalledMock).not.toHaveBeenCalled();
  });

  test("skips provisioning for a foreign wrapper", async () => {
    readFileSyncResult = "#!/bin/sh\necho not ours\n";

    expect(await provisionCliForWrapper()).toBe(false);
    expect(ensureCliInstalledMock).not.toHaveBeenCalled();
  });

  test("propagates install failures to the caller", async () => {
    readFileSyncResult = buildWrapperScript();
    ensureCliInstalledMock.mockRejectedValueOnce(new Error("offline"));

    await expect(provisionCliForWrapper()).rejects.toThrow("offline");
  });
});

// --- getCliPathInstallState ---

describe("getCliPathInstallState", () => {
  test("returns not-installed when the wrapper is absent, without consulting shell-path", async () => {
    readFileSyncResult = null;

    expect(await getCliPathInstallState()).toEqual({ kind: "not-installed" });
    expect(resolveShellPathCalls).toBe(0);
    expect(findExecutablesCalls).toHaveLength(0);
  });

  test("returns foreign-file for a foreign wrapper, without consulting shell-path", async () => {
    readFileSyncResult = "#!/bin/sh\necho not ours\n";

    expect(await getCliPathInstallState()).toEqual({ kind: "foreign-file" });
    expect(resolveShellPathCalls).toBe(0);
    expect(findExecutablesCalls).toHaveLength(0);
  });

  test("returns installed with inPath false when no hits and wrapper dir is not in PATH", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = "/usr/local/bin:/usr/bin:/bin";
    shellPathHits = [];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: false,
      runtimeReady: false,
    });
    expect(findExecutablesCalls).toEqual([["vellum", shellPathValue]]);
  });

  test("returns installed with inPath true when the wrapper is the first hit", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `${wrapperDir}:/usr/local/bin:/usr/bin:/bin`;
    shellPathHits = [wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("returns shadowed with inPath true when another vellum precedes the wrapper", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `/opt/homebrew/bin:${wrapperDir}:/usr/bin:/bin`;
    shellPathHits = ["/opt/homebrew/bin/vellum", wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("returns shadowed with inPath false when the wrapper dir is not in PATH", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = "/opt/homebrew/bin:/usr/bin:/bin";
    shellPathHits = ["/opt/homebrew/bin/vellum"];

    expect(await getCliPathInstallState()).toEqual({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: false,
      runtimeReady: false,
    });
  });

  test("does not report shadowed when the first hit symlinks to the wrapper", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `${mockHome}/bin:/usr/bin:/bin`;
    shellPathHits = [`${mockHome}/bin/vellum`]; // ~/bin -> ~/.local/bin
    realpathMap[`${mockHome}/bin/vellum`] = wrapperPath;
    realpathMap[wrapperPath] = wrapperPath;

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("still reports shadowed when realpath resolution fails (string-compare fallback)", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `/opt/homebrew/bin:${wrapperDir}`;
    shellPathHits = ["/opt/homebrew/bin/vellum", wrapperPath];
    // realpathMap left empty → realpathSync throws for both sides.

    expect(await getCliPathInstallState()).toEqual({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("returns installed when the wrapper wins over a later npm copy", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `${wrapperDir}:/opt/homebrew/bin:/usr/bin:/bin`;
    shellPathHits = [wrapperPath, "/opt/homebrew/bin/vellum"];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("counts a trailing-slash PATH entry for the wrapper dir as inPath", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = `/usr/local/bin:${wrapperDir}/:/usr/bin`;
    shellPathHits = [wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: true,
      runtimeReady: false,
    });
  });

  test("reports runtimeReady true when the CLI runtime is provisioned", async () => {
    readFileSyncResult = buildWrapperScript();
    cliBinExists = true;
    shellPathValue = `${wrapperDir}:/usr/bin:/bin`;
    shellPathHits = [wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: true,
      runtimeReady: true,
    });
  });

  test("shadowed also carries runtimeReady when the runtime is provisioned", async () => {
    readFileSyncResult = buildWrapperScript();
    cliBinExists = true;
    shellPathValue = `/opt/homebrew/bin:${wrapperDir}`;
    shellPathHits = ["/opt/homebrew/bin/vellum", wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "shadowed",
      shadowedBy: "/opt/homebrew/bin/vellum",
      inPath: true,
      runtimeReady: true,
    });
  });

  test("null shell PATH degrades to installed/inPath:false without shadow probing", async () => {
    readFileSyncResult = buildWrapperScript();
    shellPathValue = null;
    shellPathHits = ["/opt/homebrew/bin/vellum", wrapperPath];

    expect(await getCliPathInstallState()).toEqual({
      kind: "installed",
      inPath: false,
      runtimeReady: false,
    });
    expect(findExecutablesCalls).toHaveLength(0);
  });
});
