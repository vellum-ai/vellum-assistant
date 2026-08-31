import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { withRuntimeNodePath } from "../src/shared/runtime-environment";
import { resolveBuildCommitSha } from "./build-metadata";
import { installPinnedBun } from "./bun-release";
import { findPackageDir } from "./package-runtime-packages";

interface RuntimeTarget {
  readonly name: string;
  readonly entry: string;
  readonly externals?: readonly string[];
  readonly defines?: Readonly<Record<string, string>>;
  readonly hideConsole?: boolean;
}

const windowsDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(windowsDir, "..", "..");
const outputDir = path.join(windowsDir, "resources", "cli-runtime");
const releaseChannel = process.env.VELLUM_ENVIRONMENT || "local";
const targetArch = process.env.ELECTRON_TARGET_ARCH ?? process.arch;
if (targetArch !== "x64" && targetArch !== "arm64") {
  throw new Error(`Unsupported Windows runtime architecture: ${targetArch}`);
}
if (targetArch !== process.arch) {
  throw new Error(`${targetArch} runtime packaging requires a native runner.`);
}
const compileTarget = `bun-windows-${targetArch}`;
const calculateRuntimeBuildId = (runtimeDir: string): string => {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(runtimeDir, absolute).replaceAll("\\", "/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(relative);
        hash.update("\0link\0");
        hash.update(readlinkSync(absolute));
        hash.update("\0");
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      hash.update(relative);
      hash.update("\0");
      hash.update(readFileSync(absolute));
      hash.update("\0");
    }
  };
  visit(runtimeDir);
  return hash.digest("hex");
};
const readPackageVersion = async (packageDir: string): Promise<string> => {
  const manifest = (await Bun.file(
    path.join(repoRoot, packageDir, "package.json"),
  ).json()) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`${packageDir}/package.json has no valid version.`);
  }
  return manifest.version;
};
const appVersion = await readPackageVersion("clients/windows");
const cliVersion = await readPackageVersion("cli");
const assistantVersion = await readPackageVersion("assistant");
const gatewayVersion = await readPackageVersion("gateway");
const commitSha = resolveBuildCommitSha();
const bunVersion = (
  await Bun.file(path.join(repoRoot, ".tool-versions")).text()
).match(/^bun\s+(\S+)$/m)?.[1];

if (!bunVersion) {
  throw new Error("The pinned Bun version is missing from .tool-versions.");
}
if (process.platform !== "win32") {
  throw new Error("The Windows CLI runtime must be packaged on Windows.");
}
const currentBun = spawnSync(process.execPath, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (currentBun.status !== 0 || currentBun.stdout.trim() !== bunVersion) {
  throw new Error(`Packaging requires Bun ${bunVersion}.`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const assistantDefines = {
  "process.env.APP_VERSION": JSON.stringify(assistantVersion),
  "process.env.COMMIT_SHA": JSON.stringify(commitSha),
};
const assistantExternals = [
  "chromium-bidi/*",
  "sharp",
  "@img/*",
  "detect-libc",
  "semver",
] as const;
const targets: readonly RuntimeTarget[] = [
  {
    name: "vellum.exe",
    entry: "cli/src/index.ts",
  },
  {
    name: "assistant.exe",
    entry: "assistant/src/windows-compiled-entry.ts",
    externals: assistantExternals,
    defines: assistantDefines,
  },
  {
    name: "vellum-daemon.exe",
    entry: "assistant/src/daemon/windows-compiled-entry.ts",
    externals: assistantExternals,
    defines: assistantDefines,
    hideConsole: true,
  },
  {
    name: "vellum-gateway.exe",
    entry: "gateway/src/index.ts",
    externals: ["drizzle-kit", "drizzle-kit/*"],
    defines: {
      "process.env.APP_VERSION": JSON.stringify(gatewayVersion),
    },
    hideConsole: true,
  },
  {
    name: "vellum-worker.exe",
    entry: "assistant/src/windows-compiled-worker-entry.ts",
    externals: assistantExternals,
    defines: assistantDefines,
    hideConsole: true,
  },
  {
    name: "credential-executor.exe",
    entry: "credential-executor/src/main.ts",
    hideConsole: true,
  },
  {
    name: "cli-launcher.exe",
    entry: "clients/windows/scripts/launch-cli.ts",
  },
  {
    name: "cli-uninstaller.exe",
    entry: "clients/windows/scripts/uninstall-cli.ts",
  },
];
for (const { name, entry, externals, defines, hideConsole } of targets) {
  const args = ["build", "--compile", `--target=${compileTarget}`];
  if (hideConsole) {
    args.push("--windows-hide-console");
  }
  for (const external of externals ?? []) {
    args.push("--external", external);
  }
  for (const [key, value] of Object.entries(defines ?? {})) {
    args.push("--define", `${key}=${value}`);
  }
  args.push(
    path.join(repoRoot, entry),
    "--outfile",
    path.join(outputDir, name),
  );
  const build = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0) {
    throw new Error(`Failed to compile ${name} (exit ${build.status}).`);
  }
}

const nativeSharpPackage = `@img/sharp-win32-${targetArch}`;
const assistantPackageDir = path.join(repoRoot, "assistant");
const gatewayPackageDir = path.join(repoRoot, "gateway");
const sharpPackageDir = findPackageDir("sharp", assistantPackageDir);
const runtimePackages = [
  {
    packageName: "sharp",
    resolveSpecifier: "sharp",
    basedir: assistantPackageDir,
  },
  {
    packageName: "@img/colour",
    resolveSpecifier: "@img/colour",
    basedir: sharpPackageDir,
  },
  {
    packageName: nativeSharpPackage,
    resolveSpecifier: `${nativeSharpPackage}/sharp.node`,
    basedir: sharpPackageDir,
  },
  {
    packageName: "detect-libc",
    resolveSpecifier: "detect-libc",
    basedir: sharpPackageDir,
  },
  {
    packageName: "semver",
    resolveSpecifier: "semver",
    basedir: sharpPackageDir,
  },
  {
    packageName: "drizzle-kit",
    resolveSpecifier: "drizzle-kit/api",
    basedir: gatewayPackageDir,
  },
  {
    packageName: "drizzle-orm",
    resolveSpecifier: "drizzle-orm",
    basedir: gatewayPackageDir,
  },
] as const;
const runtimeNodeModules = path.join(outputDir, "node_modules");
mkdirSync(runtimeNodeModules, { recursive: true });
for (const { packageName, resolveSpecifier, basedir } of runtimePackages) {
  cpSync(
    findPackageDir(resolveSpecifier, basedir),
    path.join(runtimeNodeModules, ...packageName.split("/")),
    { recursive: true },
  );
}
const packagedAssistant = path.join(outputDir, "assistant.exe");
const versionCheck = spawnSync(packagedAssistant, ["--version"], {
  encoding: "utf8",
  env: withRuntimeNodePath(packagedAssistant),
  windowsHide: true,
});
const versionOutput = versionCheck.stdout?.trim() ?? "";
const versionErrorOutput = versionCheck.stderr?.trim() ?? "";
if (versionCheck.status !== 0 || versionOutput !== assistantVersion) {
  const diagnostics = [
    `exit ${versionCheck.status ?? "not started"}`,
    versionCheck.error ? `spawn error: ${versionCheck.error.message}` : null,
    versionErrorOutput ? `stderr: ${versionErrorOutput}` : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join("; ");
  throw new Error(
    `Packaged assistant version check failed: expected ${assistantVersion}, got ${versionOutput || "no output"} (${diagnostics}).`,
  );
}
const packagedCli = path.join(outputDir, "vellum.exe");
const cliVersionCheck = spawnSync(packagedCli, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
const expectedCliVersion = `@vellumai/cli v${cliVersion}`;
const cliVersionOutput = cliVersionCheck.stdout?.trim() ?? "";
const cliVersionErrorOutput = cliVersionCheck.stderr?.trim() ?? "";
if (cliVersionCheck.status !== 0 || cliVersionOutput !== expectedCliVersion) {
  const diagnostics = [
    `exit ${cliVersionCheck.status ?? "not started"}`,
    cliVersionCheck.error
      ? `spawn error: ${cliVersionCheck.error.message}`
      : null,
    cliVersionErrorOutput ? `stderr: ${cliVersionErrorOutput}` : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join("; ");
  throw new Error(
    `Packaged CLI version check failed: expected ${expectedCliVersion}, got ${cliVersionOutput || "no output"} (${diagnostics}).`,
  );
}
for (const [source, name] of [
  ["assistant/src/prompts/templates", "templates"],
  ["assistant/src/config/bundled-skills", "bundled-skills"],
  ["assistant/src/runtime/routes/brain-graph", "brain-graph"],
  ["assistant/src/plugins/defaults", "default-plugins"],
  ["skills", "first-party-skills"],
  ["clients/windows/resources/web-dist", "web-dist"],
] as const) {
  cpSync(path.join(repoRoot, source), path.join(outputDir, name), {
    recursive: true,
  });
}
for (const [specifier, name] of [
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm"],
] as const) {
  copyFileSync(
    Bun.resolveSync(specifier, path.join(repoRoot, "gateway")),
    path.join(outputDir, name),
  );
}
copyFileSync(
  path.join(repoRoot, "meta", "feature-flags", "feature-flag-registry.json"),
  path.join(outputDir, "feature-flag-registry.json"),
);
const pluginApiShim = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "assistant", "scripts", "write-plugin-api-shim.ts"),
    outputDir,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (pluginApiShim.status !== 0) {
  throw new Error(
    `Failed to package the plugin API shim (exit ${pluginApiShim.status}).`,
  );
}
const bunSource = await installPinnedBun({
  arch: targetArch,
  cacheDir: path.join(windowsDir, "out", "bun-cache"),
  destination: path.join(outputDir, "bun.exe"),
  hostExecutable: process.execPath,
  version: bunVersion,
});
console.log(`Bundled Bun ${bunVersion} (${targetArch}) from ${bunSource}.`);
const runtimeBuildId = calculateRuntimeBuildId(outputDir);
await Bun.write(
  path.join(outputDir, "runtime.json"),
  `${JSON.stringify({ version: appVersion, bunVersion, runtimeBuildId, releaseChannel, architecture: targetArch })}\n`,
);
