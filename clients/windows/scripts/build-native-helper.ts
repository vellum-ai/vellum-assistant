import assert from "node:assert/strict";
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
  assert.equal(globalJson.sdk.version, "10.0.302");
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
  if (!Bun.which("dotnet")) {
    throw new Error(
      "The pinned .NET SDK is required to build the native helper",
    );
  }
  if (process.argv.includes("--test")) {
    await runNativeCommand(
      [
        "dotnet",
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
  for (const architecture of resolveArchitectures(
    argValue("--arch"),
    "all",
  )) {
    await runNativeCommand(
      [
        "dotnet",
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
