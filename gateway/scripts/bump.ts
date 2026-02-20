import { resolve } from "path";

const GATEWAY_DIR = resolve(import.meta.dirname, "..");
const ASSISTANT_DIR = resolve(GATEWAY_DIR, "../assistant");

const gatewayPkgPath = resolve(GATEWAY_DIR, "package.json");
const assistantPkgPath = resolve(ASSISTANT_DIR, "package.json");
const assistantLockPath = resolve(ASSISTANT_DIR, "bun.lock");

function bumpPatch(version: string): string {
  const parts = version.split(".");
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join(".");
}

const gatewayPkg = await Bun.file(gatewayPkgPath).json();
const oldVersion: string = gatewayPkg.version;
const newVersion = bumpPatch(oldVersion);
gatewayPkg.version = newVersion;
await Bun.write(gatewayPkgPath, JSON.stringify(gatewayPkg, null, 2) + "\n");

const assistantPkg = await Bun.file(assistantPkgPath).json();
assistantPkg.dependencies["@vellumai/vellum-gateway"] = newVersion;
assistantPkg.version = bumpPatch(assistantPkg.version);
await Bun.write(assistantPkgPath, JSON.stringify(assistantPkg, null, 2) + "\n");

let lockContent = await Bun.file(assistantLockPath).text();
lockContent = lockContent.replace(
  /"@vellumai\/vellum-gateway": "[^"]*"/g,
  `"@vellumai/vellum-gateway": "${newVersion}"`
);
lockContent = lockContent.replace(
  /@vellumai\/vellum-gateway@\d+\.\d+\.\d+/g,
  `@vellumai/vellum-gateway@${newVersion}`
);
await Bun.write(assistantLockPath, lockContent);
