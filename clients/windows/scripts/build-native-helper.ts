import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveArchitectures,
  runNativeCommand,
} from "./build-preview-handler";
import { argValue } from "./cli-args";

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
const dotnetDownloads = {
  arm64: {
    hash: "241abb2b345cff1b32d87a9e29da5e9d52f899f691e7b34661274477564c4717054c489814a9fd7a5526fc9e0d8174a0d951a4a845556eee53add526f71917e7",
    url: "https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.302/dotnet-sdk-10.0.302-win-arm64.zip",
  },
  x64: {
    hash: "7d170ed75fa9af34c00646621d92011dbd71943952e2787cd15df9be78e6452b55dadef34d7eff77b802e6af4959e071a55855ac649afeac70901c3a2a258716",
    url: "https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.302/dotnet-sdk-10.0.302-win-x64.zip",
  },
} as const;

const dotnetArchitecture = (): keyof typeof dotnetDownloads =>
  process.arch === "arm64" ? "arm64" : "x64";

export const dotnetEnvironment = (
  environment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> => {
  const result = { ...environment };
  delete result.MSBUILD_EXE_PATH;
  return result;
};

const projectDotnetPath = (): string =>
  join(
    windowsRoot,
    "resources",
    "dotnet-sdk",
    dotnetArchitecture(),
    "dotnet.exe",
  );

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

const dotnetCandidates = (): string[] =>
  [Bun.which("dotnet"), bundledDotnetPath(), projectDotnetPath()].filter(
    (candidate): candidate is string => candidate !== null && existsSync(candidate),
  );

const hasPinnedDotnetSdk = async (dotnet: string): Promise<boolean> => {
  const child = Bun.spawn([dotnet, "--list-sdks"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 && output.includes(`${dotnetSdkVersion} [`);
};

const findPinnedDotnet = async (): Promise<string | null> => {
  for (const dotnet of dotnetCandidates()) {
    if (await hasPinnedDotnetSdk(dotnet)) {
      return dotnet;
    }
  }
  return null;
};

const installLocalDotnet = async (): Promise<string> => {
  const { hash, url } = dotnetDownloads[dotnetArchitecture()];
  const targetDir = join(
    windowsRoot,
    "resources",
    "dotnet-sdk",
    dotnetArchitecture(),
  );
  const archivePath = `${targetDir}.zip`;
  console.log(`[native-helper] Downloading .NET SDK ${dotnetSdkVersion}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Unable to download .NET SDK ${dotnetSdkVersion}: ${response.status}`,
    );
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  const actualHash = createHash("sha512").update(archive).digest("hex");
  if (actualHash !== hash) {
    throw new Error("Downloaded .NET SDK failed checksum verification");
  }
  await mkdir(join(windowsRoot, "resources", "dotnet-sdk"), {
    recursive: true,
  });
  await Bun.write(archivePath, archive);
  try {
    await mkdir(targetDir, { recursive: true });
    const powershell = Bun.which("powershell.exe") ?? "powershell.exe";
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    await runNativeCommand(
      [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(targetDir)} -Force`,
      ],
      nativeRoot,
    );
  } finally {
    await rm(archivePath, { force: true });
  }
  const dotnet = await findPinnedDotnet();
  if (!dotnet) {
    throw new Error(
      `The .NET SDK ${dotnetSdkVersion} installation did not complete`,
    );
  }
  return dotnet;
};

const ensureDotnet = async (): Promise<string> => {
  const installed = await findPinnedDotnet();
  if (installed) {
    return installed;
  }
  if (process.platform !== "win32") {
    throw new Error(
      `The pinned .NET SDK ${dotnetSdkVersion} is required to build the native helper`,
    );
  }
  const winget = Bun.which("winget");
  if (winget) {
    console.log(`[native-helper] Installing .NET SDK ${dotnetSdkVersion}`);
    try {
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
      const dotnet = await findPinnedDotnet();
      if (dotnet) {
        return dotnet;
      }
    } catch {
      console.warn(
        "[native-helper] Windows Package Manager install failed; downloading locally",
      );
    }
  }
  return installLocalDotnet();
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
  assert.deepEqual(
    dotnetEnvironment({ MSBUILD_EXE_PATH: "C:\\msbuild.exe", PATH: "C:\\bin" }),
    { PATH: "C:\\bin" },
  );
};

const main = async (): Promise<void> => {
  await checkConfiguration();
  if (process.argv.includes("--check")) {
    return;
  }
  const dotnet = await ensureDotnet();
  const environment = dotnetEnvironment();
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
      environment,
    );
  }
  // CI passes --arch all; local dev builds the current architecture.
  for (const architecture of resolveArchitectures(
    argValue("--arch"),
    process.env.ELECTRON_TARGET_ARCH ?? process.arch,
  )) {
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
      environment,
    );
  }
};

if (import.meta.main) {
  await main();
}
