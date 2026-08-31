import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "./cli-args";

export type PreviewArchitecture = "x64" | "arm64";

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(windowsRoot, "native");
const handlerRoot = join(nativeRoot, "Vellum.PreviewHandler");
const fixtureRoot = join(nativeRoot, "fixtures", "vellum-bundle-contract");
const managedBuildToolsRoot = join(windowsRoot, ".build-tools");
const vcpkgManifest = join(handlerRoot, "vcpkg.json");
const vcpkgRepository = "https://github.com/microsoft/vcpkg.git";
const previewClsid = "{5888DF89-8AD1-4D76-87C4-548A79E8C2E5}";
const thumbnailClsid = "{C90464A7-6608-44C9-8983-2EA82F10E454}";

export function resolveArchitectures(
  requested?: string,
  host: string = process.arch,
): PreviewArchitecture[] {
  if (requested === "all" || (requested === undefined && host === "all")) {
    return ["x64", "arm64"];
  }
  if (requested === "x64" || requested === "arm64") {
    return [requested];
  }
  if (requested !== undefined) {
    throw new Error(`Unsupported architecture: ${requested}`);
  }
  return [host === "arm64" ? "arm64" : "x64"];
}

export function registrationMetadata(architecture: PreviewArchitecture) {
  return {
    architecture,
    dll: "Vellum.PreviewHandler.dll",
    extension: ".vellum",
    isolation: { previewHost: "prevhost.exe", disableProcessIsolation: false },
    classes: {
      [previewClsid]: {
        name: "Vellum Bundle Preview",
        appId: "{534A1E02-D58F-44F0-B58B-36CBED287C7C}",
        threadingModel: "Apartment",
      },
      [thumbnailClsid]: {
        name: "Vellum Bundle Thumbnail",
        threadingModel: "Apartment",
      },
    },
    associations: {
      "{8895B1C6-B41F-4C1C-A562-0D564250836F}": previewClsid,
      "{E357FCCD-A995-4576-B01F-234630154E96}": thumbnailClsid,
    },
    listedPreviewHandlers: [previewClsid],
  };
}

const withTrailingSlash = (path: string): string =>
  path.endsWith("\\") || path.endsWith("/") ? path : `${path}\\`;

export function vcpkgMsbuildArguments(
  root: string,
  installedDir: string,
): string[] {
  return [
    `/p:VcpkgRoot=${withTrailingSlash(root)}`,
    `/p:VcpkgInstalledDir=${withTrailingSlash(installedDir)}`,
    "/p:VcpkgEnabled=false",
    "/p:VcpkgManifestInstall=false",
  ];
}

async function readVcpkgBaseline(): Promise<string> {
  const manifest = (await Bun.file(vcpkgManifest).json()) as {
    "builtin-baseline"?: unknown;
  };
  const baseline = manifest["builtin-baseline"];
  if (typeof baseline !== "string" || !/^[0-9a-f]{40}$/.test(baseline)) {
    throw new Error("vcpkg.json must contain a 40-character builtin-baseline");
  }
  return baseline;
}

async function bootstrapManagedVcpkg(
  buildToolsRoot: string,
  baseline: string,
): Promise<string> {
  const checkoutsRoot = join(buildToolsRoot, "vcpkg");
  const targetRoot = join(checkoutsRoot, baseline);
  const targetExecutable = join(targetRoot, "vcpkg.exe");
  if (existsSync(targetExecutable)) {
    return targetRoot;
  }

  const git = Bun.which("git");
  if (!git) {
    throw new Error("Git is required to install the Windows vcpkg build tool");
  }

  await mkdir(checkoutsRoot, { recursive: true });
  const resolvedToolsRoot = resolve(buildToolsRoot);
  const resolvedTargetRoot = resolve(targetRoot);
  if (!resolvedTargetRoot.startsWith(`${resolvedToolsRoot}${sep}`)) {
    throw new Error("Refusing to initialize vcpkg outside the build-tools root");
  }
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  try {
    console.log(
      `[preview-handler] Installing pinned vcpkg ${baseline.slice(0, 12)}...`,
    );
    await runNativeCommand([git, "-C", targetRoot, "init"]);
    await runNativeCommand([
      git,
      "-C",
      targetRoot,
      "config",
      "core.longpaths",
      "true",
    ]);
    await runNativeCommand([
      git,
      "-C",
      targetRoot,
      "remote",
      "add",
      "origin",
      vcpkgRepository,
    ]);
    await runNativeCommand([
      git,
      "-C",
      targetRoot,
      "fetch",
      "--depth=1",
      "origin",
      baseline,
    ]);
    await runNativeCommand([
      git,
      "-C",
      targetRoot,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const commandShell =
      process.env.ComSpec ?? win32.join(systemRoot, "System32", "cmd.exe");
    const bootstrap = join(targetRoot, "bootstrap-vcpkg.bat");
    await runNativeCommand(
      [commandShell, "/d", "/c", "call", bootstrap, "-disableMetrics"],
      targetRoot,
    );
    if (!existsSync(targetExecutable)) {
      throw new Error("vcpkg bootstrap completed without creating vcpkg.exe");
    }
    return targetRoot;
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

async function ensureVcpkgRoot(): Promise<string> {
  return bootstrapManagedVcpkg(
    managedBuildToolsRoot,
    await readVcpkgBaseline(),
  );
}

function testArchitectureSelection() {
  assert.deepEqual(resolveArchitectures(undefined, "x64"), ["x64"]);
  assert.deepEqual(resolveArchitectures(undefined, "arm64"), ["arm64"]);
  assert.deepEqual(resolveArchitectures("all", "x64"), ["x64", "arm64"]);
  assert.throws(() => resolveArchitectures("ia32"), /Unsupported architecture/);
  assert.deepEqual(vcpkgMsbuildArguments("C:\\vcpkg", "C:\\installed"), [
    "/p:VcpkgRoot=C:\\vcpkg\\",
    "/p:VcpkgInstalledDir=C:\\installed\\",
    "/p:VcpkgEnabled=false",
    "/p:VcpkgManifestInstall=false",
  ]);
  assert.deepEqual(vcpkgMsbuildArguments("C:\\vcpkg\\", "C:\\installed\\"), [
    "/p:VcpkgRoot=C:\\vcpkg\\",
    "/p:VcpkgInstalledDir=C:\\installed\\",
    "/p:VcpkgEnabled=false",
    "/p:VcpkgManifestInstall=false",
  ]);
  const project = readFileSync(
    join(handlerRoot, "Vellum.PreviewHandler.vcxproj"),
    "utf8",
  );
  assert.match(
    project,
    /\$\(VcpkgInstalledDir\)\$\(VcpkgTriplet\)\\include/,
  );
  assert.match(project, /<AdditionalDependencies>zs\.lib;/);
}

export async function runNativeCommand(
  command: string[],
  cwd = windowsRoot,
  env: Record<string, string | undefined> = process.env,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stderr: "inherit",
    stdout: "inherit",
    windowsHide: true,
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

async function portableTest() {
  const vcpkgRoot =
    process.env.VCPKG_ROOT ?? process.env.VCPKG_INSTALLATION_ROOT;
  const vcpkg = vcpkgRoot ? join(vcpkgRoot, "vcpkg") : Bun.which("vcpkg");
  if (!vcpkg) {
    throw new Error("vcpkg is required for portable parser tests");
  }
  const triplet = `${process.arch}-${process.platform === "darwin" ? "osx" : "linux"}`;
  const scratch = await mkdtemp(join(tmpdir(), "vellum-preview-test-"));
  const installed = join(scratch, "vcpkg");
  try {
    await runNativeCommand([
      vcpkg,
      "install",
      `--x-manifest-root=${handlerRoot}`,
      `--x-install-root=${installed}`,
      `--triplet=${triplet}`,
    ]);
    const executable = join(scratch, "BundleReaderTests");
    await runNativeCommand([
      "c++",
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(handlerRoot, "BundleReader.cpp"),
      join(nativeRoot, "Vellum.PreviewHandler.Tests", "BundleReaderTests.cpp"),
      `-I${handlerRoot}`,
      `-I${join(installed, triplet, "include")}`,
      `-L${join(installed, triplet, "lib")}`,
      "-lz",
      "-o",
      executable,
    ]);
    await runNativeCommand([executable, fixtureRoot]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes("--test-architecture")) {
    testArchitectureSelection();
    return;
  }
  if (process.platform !== "win32") {
    if (process.argv.includes("--native-test")) {
      await portableTest();
      return;
    }
    throw new Error(
      "Preview handler builds require Windows; use --native-test for the portable parser suite",
    );
  }
  const msbuild = process.env.MSBUILD_EXE_PATH ?? Bun.which("msbuild");
  if (!msbuild) {
    throw new Error("MSBuild is required in a Visual Studio developer shell");
  }
  const vcpkgRoot = await ensureVcpkgRoot();
  const vcpkg = join(vcpkgRoot, "vcpkg.exe");
  console.log(`[preview-handler] Using vcpkg: ${vcpkg}`);
  const installedDir = join(handlerRoot, "vcpkg_installed");
  const vcpkgArguments = vcpkgMsbuildArguments(vcpkgRoot, installedDir);
  for (const architecture of resolveArchitectures(
    argValue("--arch"),
    process.env.ELECTRON_TARGET_ARCH ?? process.arch,
  )) {
    const platform = architecture === "arm64" ? "ARM64" : "x64";
    const triplet = `${architecture}-windows-static-md`;
    const project = join(handlerRoot, "Vellum.PreviewHandler.vcxproj");
    await runNativeCommand([
      vcpkg,
      "install",
      "--x-wait-for-lock",
      `--triplet=${triplet}`,
      `--vcpkg-root=${vcpkgRoot}`,
      `--x-manifest-root=${handlerRoot}`,
      `--x-install-root=${installedDir}`,
    ]);
    await runNativeCommand([
      msbuild,
      project,
      "/p:Configuration=Release",
      `/p:Platform=${platform}`,
      ...vcpkgArguments,
      "/m",
    ]);
    await runNativeCommand([
      msbuild,
      project,
      "/p:Configuration=Tests",
      `/p:Platform=${platform}`,
      ...vcpkgArguments,
      "/m",
    ]);
    const output = join(handlerRoot, "build", platform, "Release");
    await writeFile(
      join(output, "registration.json"),
      `${JSON.stringify(registrationMetadata(architecture), null, 2)}\n`,
    );
    if (architecture === (process.arch === "arm64" ? "arm64" : "x64")) {
      await runNativeCommand([
        join(handlerRoot, "build", platform, "Tests", "BundleReaderTests.exe"),
        fixtureRoot,
      ]);
    }
  }
}

if (import.meta.main) {
  await main();
}
