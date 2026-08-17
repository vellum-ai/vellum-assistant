import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveArchitectures,
  runNativeCommand,
} from "./build-preview-handler";

const windowsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(windowsRoot, "native");
const helperProject = join(
  nativeRoot,
  "Vellum.WindowsHelper",
  "Vellum.WindowsHelper.csproj",
);
const testProject = join(
  nativeRoot,
  "Vellum.WindowsHelper.Tests",
  "Vellum.WindowsHelper.Tests.csproj",
);
const dotnetSdkVersion = "10.0.302";

const bundledDotnetPath = (): string | null => {
  if (process.platform !== "win32") {
    return null;
  }
  const candidate = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "dotnet",
    "dotnet.exe",
  );
  return existsSync(candidate) ? candidate : null;
};

const resolveDotnet = (): string | null =>
  Bun.which("dotnet") ?? bundledDotnetPath();

const hasPinnedDotnetSdk = async (dotnet: string): Promise<boolean> => {
  const child = Bun.spawn([dotnet, "--list-sdks"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 && output.includes(`${dotnetSdkVersion} [`);
};

const ensureDotnet = async (): Promise<string> => {
  const installed = resolveDotnet();
  if (installed && (await hasPinnedDotnetSdk(installed))) {
    return installed;
  }
  if (process.platform !== "win32") {
    throw new Error(
      `The pinned .NET SDK ${dotnetSdkVersion} is required to build the native helper`,
    );
  }
  const winget = Bun.which("winget");
  if (!winget) {
    throw new Error(
      `Install .NET SDK ${dotnetSdkVersion}: Windows Package Manager is unavailable`,
    );
  }
  console.log(`[native-helper] Installing .NET SDK ${dotnetSdkVersion}`);
  await runNativeCommand(
    [
      winget,
      "install",
      "--id",
      "Microsoft.dotnet.SDK.10",
      "--exact",
      "--version",
      dotnetSdkVersion,
      "--source",
      "winget",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    nativeRoot,
  );
  const dotnet = resolveDotnet();
  if (!dotnet || !(await hasPinnedDotnetSdk(dotnet))) {
    throw new Error(
      `The .NET SDK ${dotnetSdkVersion} installation did not complete`,
    );
  }
  return dotnet;
};

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return (
    inline?.slice(flag.length + 1) ??
    (index >= 0 ? process.argv[index + 1] : undefined)
  );
};

const checkConfiguration = async (): Promise<void> => {
  const globalJson = await Bun.file(join(nativeRoot, "global.json")).json();
  assert.equal(globalJson.sdk.version, dotnetSdkVersion);
  const project = await Bun.file(helperProject).text();
  assert.match(
    project,
    /<RuntimeIdentifiers>win-x64;win-arm64<\/RuntimeIdentifiers>/,
  );
  assert.match(project, /<SelfContained>true<\/SelfContained>/);
};

const main = async (): Promise<void> => {
  await checkConfiguration();
  if (process.argv.includes("--check")) {
    return;
  }
  const dotnet = await ensureDotnet();
  if (process.argv.includes("--test")) {
    await runNativeCommand(
      [
        dotnet,
        "run",
        "--project",
        testProject,
        "-c",
        "Release",
        "-r",
        "win-x64",
      ],
      nativeRoot,
    );
  }
  for (const architecture of resolveArchitectures(argValue("--arch"), "all")) {
    await runNativeCommand(
      [
        dotnet,
        "publish",
        helperProject,
        "-c",
        "Release",
        "-r",
        `win-${architecture}`,
        "--self-contained",
        "true",
        "-o",
        join(windowsRoot, "resources", "native-helper", architecture),
      ],
      nativeRoot,
    );
  }
};

if (import.meta.main) {
  await main();
}
