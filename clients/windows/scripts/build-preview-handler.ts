import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "./cli-args";

export type PreviewArchitecture = "x64" | "arm64";

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(windowsRoot, "native");
const handlerRoot = join(nativeRoot, "Vellum.PreviewHandler");
const fixtureRoot = join(nativeRoot, "fixtures", "vellum-bundle-contract");
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
    "/p:VcpkgManifestInstall=false",
  ];
}

export function resolveVcpkgRoot(
  environment: Record<string, string | undefined> = process.env,
  findVcpkg: () => string | null = () => Bun.which("vcpkg"),
  pathExists: (path: string) => boolean = existsSync,
): string | undefined {
  const configuredRoot =
    environment.VCPKG_ROOT ?? environment.VCPKG_INSTALLATION_ROOT;
  if (configuredRoot) {
    return configuredRoot;
  }
  if (environment.LOCALAPPDATA) {
    const managedRoot = win32.join(
      environment.LOCALAPPDATA,
      "vellum-build-tools",
      "vcpkg",
    );
    if (pathExists(win32.join(managedRoot, "vcpkg.exe"))) {
      return managedRoot;
    }
  }
  const executable = findVcpkg();
  return executable ? win32.dirname(executable) : undefined;
}

function testArchitectureSelection() {
  assert.deepEqual(resolveArchitectures(undefined, "x64"), ["x64"]);
  assert.deepEqual(resolveArchitectures(undefined, "arm64"), ["arm64"]);
  assert.deepEqual(resolveArchitectures("all", "x64"), ["x64", "arm64"]);
  assert.throws(() => resolveArchitectures("ia32"), /Unsupported architecture/);
  assert.deepEqual(vcpkgMsbuildArguments("C:\\vcpkg", "C:\\installed"), [
    "/p:VcpkgRoot=C:\\vcpkg\\",
    "/p:VcpkgInstalledDir=C:\\installed\\",
    "/p:VcpkgManifestInstall=false",
  ]);
  assert.deepEqual(vcpkgMsbuildArguments("C:\\vcpkg\\", "C:\\installed\\"), [
    "/p:VcpkgRoot=C:\\vcpkg\\",
    "/p:VcpkgInstalledDir=C:\\installed\\",
    "/p:VcpkgManifestInstall=false",
  ]);
  assert.equal(
    resolveVcpkgRoot(
      { VCPKG_ROOT: "C:\\configured" },
      () => null,
      () => false,
    ),
    "C:\\configured",
  );
  assert.equal(
    resolveVcpkgRoot(
      { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      () => null,
      () => true,
    ),
    "C:\\Users\\user\\AppData\\Local\\vellum-build-tools\\vcpkg",
  );
  assert.equal(
    resolveVcpkgRoot(
      {},
      () => "C:\\tools\\vcpkg.exe",
      () => false,
    ),
    "C:\\tools",
  );
  assert.equal(
    resolveVcpkgRoot(
      {},
      () => null,
      () => false,
    ),
    undefined,
  );
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
  const vcpkgRoot = resolveVcpkgRoot();
  if (!vcpkgRoot) {
    throw new Error("vcpkg is required; set VCPKG_ROOT or add vcpkg to PATH");
  }
  const vcpkg = join(vcpkgRoot, "vcpkg.exe");
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
