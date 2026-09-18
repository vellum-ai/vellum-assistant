import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

// Repository setup is best-effort, including installs outside a Git checkout.
function run(command: string, args: string[]): boolean {
  return (
    spawnSync(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "ignore"],
      windowsHide: true,
    }).status === 0
  );
}

if (!run("git", ["config", "core.hooksPath"])) {
  run("git", ["config", "core.hooksPath", ".githooks"]);
}

const syncScript = join(repoRoot, "meta", "sync-bundled-copies.ts");
if (existsSync(syncScript) && run(process.execPath, ["run", syncScript])) {
  run(process.execPath, [
    "run",
    join(
      repoRoot,
      "assistant",
      "scripts",
      "generate-bundled-plugin-packages.ts",
    ),
  ]);
}
