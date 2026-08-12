import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const windowsDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(windowsDir, "..", "..");
const outputDir = path.join(windowsDir, "resources", "cli-runtime");
const appPackage = (await Bun.file(
  path.join(windowsDir, "package.json"),
).json()) as { version: string };
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
const build = spawnSync(
  process.execPath,
  [
    "build",
    "--compile",
    "--external",
    "react-devtools-core",
    path.join(repoRoot, "cli", "src", "index.ts"),
    "--outfile",
    path.join(outputDir, "vellum.exe"),
  ],
  { cwd: repoRoot, stdio: "inherit", windowsHide: true },
);
if (build.status !== 0) {
  throw new Error(`Failed to compile the Windows CLI (exit ${build.status}).`);
}
copyFileSync(process.execPath, path.join(outputDir, "bun.exe"));
await Bun.write(
  path.join(outputDir, "runtime.json"),
  `${JSON.stringify({ version: appPackage.version, bunVersion })}\n`,
);
