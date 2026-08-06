import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
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
const targets = [
  ["vellum.exe", "cli/src/index.ts", ["react-devtools-core"]],
  [
    "assistant.exe",
    "assistant/src/windows-compiled-entry.ts",
    ["chromium-bidi/*"],
  ],
  [
    "vellum-daemon.exe",
    "assistant/src/daemon/windows-compiled-entry.ts",
    ["chromium-bidi/*"],
  ],
  [
    "vellum-gateway.exe",
    "gateway/src/index.ts",
    [
      "@electric-sql/*",
      "@aws-sdk/client-rds-data",
      "@libsql/*",
      "@neondatabase/*",
      "@planetscale/*",
      "@vercel/*",
      "better-sqlite3",
      "mysql2/*",
      "mysql2",
      "pg",
      "postgres",
    ],
  ],
  ["credential-executor.exe", "credential-executor/src/main.ts"],
  ["cli-uninstaller.exe", "clients/windows/scripts/uninstall-cli.ts"],
] as const;
for (const [name, entry, externals] of targets) {
  const args = ["build", "--compile"];
  for (const external of externals ?? []) {
    args.push("--external", external);
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
for (const [source, name] of [
  ["assistant/src/prompts/templates", "templates"],
  ["assistant/src/config/bundled-skills", "bundled-skills"],
  ["assistant/src/runtime/routes/brain-graph", "brain-graph"],
  ["assistant/src/plugins/defaults", "default-plugins"],
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
copyFileSync(process.execPath, path.join(outputDir, "bun.exe"));
await Bun.write(
  path.join(outputDir, "runtime.json"),
  `${JSON.stringify({ version: appPackage.version, bunVersion })}\n`,
);
