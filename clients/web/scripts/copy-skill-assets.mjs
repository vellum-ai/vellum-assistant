import { cpSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../../skills");
const PUBLIC_SKILLS_DIR = resolve(__dirname, "../public/skills");

if (statSync(PUBLIC_SKILLS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  rmSync(PUBLIC_SKILLS_DIR, { recursive: true });
}

let copied = 0;

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const assetsDir = join(SKILLS_DIR, entry.name, "assets");
  if (!statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) continue;

  const destDir = join(PUBLIC_SKILLS_DIR, entry.name, "assets");
  mkdirSync(destDir, { recursive: true });
  cpSync(assetsDir, destDir, { recursive: true });
  copied++;
}

console.log(`Copied assets from ${copied} skill(s) to ${PUBLIC_SKILLS_DIR}`);
