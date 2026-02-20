import { resolve } from "path";

const CLI_DIR = resolve(import.meta.dirname, "..");
const ASSISTANT_DIR = resolve(CLI_DIR, "../assistant");

const cliPkgPath = resolve(CLI_DIR, "package.json");
const assistantPkgPath = resolve(ASSISTANT_DIR, "package.json");
const assistantLockPath = resolve(ASSISTANT_DIR, "bun.lock");

function bumpPatch(version: string): string {
  const parts = version.split(".");
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join(".");
}

const cliPkg = await Bun.file(cliPkgPath).json();
const oldVersion: string = cliPkg.version;
const newVersion = bumpPatch(oldVersion);
cliPkg.version = newVersion;
await Bun.write(cliPkgPath, JSON.stringify(cliPkg, null, 2) + "\n");

const assistantPkg = await Bun.file(assistantPkgPath).json();
assistantPkg.dependencies["@vellumai/cli"] = newVersion;
assistantPkg.version = bumpPatch(assistantPkg.version);
await Bun.write(assistantPkgPath, JSON.stringify(assistantPkg, null, 2) + "\n");

let lockContent = await Bun.file(assistantLockPath).text();
lockContent = lockContent.replace(
  /"@vellumai\/cli": "[^"]*"/g,
  `"@vellumai/cli": "${newVersion}"`
);
lockContent = lockContent.replace(
  /@vellumai\/cli@\d+\.\d+\.\d+/g,
  `@vellumai/cli@${newVersion}`
);
await Bun.write(assistantLockPath, lockContent);
