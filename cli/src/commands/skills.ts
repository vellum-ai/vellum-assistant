import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getRootDir(): string {
  return join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum");
}

function getSkillsDir(): string {
  return join(getRootDir(), "workspace", "skills");
}

function getSkillsIndexPath(): string {
  return join(getSkillsDir(), "SKILLS.md");
}

/**
 * Resolve the repo-level skills/ directory when running in dev mode.
 * Returns the path if VELLUM_DEV is set and the directory exists, or undefined.
 */
function getRepoSkillsDir(): string | undefined {
  if (!process.env.VELLUM_DEV) return undefined;

  // cli/src/commands/skills.ts -> ../../../skills/
  const candidate = join(import.meta.dir, "..", "..", "..", "skills");
  if (existsSync(join(candidate, "catalog.json"))) {
    return candidate;
  }
  return undefined;
}

/**
 * Read skills from the repo-local catalog.json.
 */
function readLocalCatalog(repoSkillsDir: string): CatalogSkill[] {
  try {
    const raw = readFileSync(
      join(repoSkillsDir, "catalog.json"),
      "utf-8",
    );
    const manifest = JSON.parse(raw) as CatalogManifest;
    if (!Array.isArray(manifest.skills)) return [];
    return manifest.skills;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Platform API client
// ---------------------------------------------------------------------------

function getConfigPlatformUrl(): string | undefined {
  try {
    const configPath = join(getRootDir(), "workspace", "config.json");
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const platform = raw.platform as Record<string, unknown> | undefined;
    const baseUrl = platform?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  } catch {
    // ignore
  }
  return undefined;
}

function getPlatformUrl(): string {
  return (
    process.env.VELLUM_ASSISTANT_PLATFORM_URL ??
    getConfigPlatformUrl() ??
    "https://platform.vellum.ai"
  );
}

function getPlatformToken(): string | null {
  try {
    return readFileSync(join(getRootDir(), "platform-token"), "utf-8").trim();
  } catch {
    return null;
  }
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getPlatformToken();
  if (token) {
    headers["X-Session-Token"] = token;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
  version?: string;
}

interface CatalogManifest {
  version: number;
  skills: CatalogSkill[];
}

// ---------------------------------------------------------------------------
// Catalog operations
// ---------------------------------------------------------------------------

async function fetchCatalog(): Promise<CatalogSkill[]> {
  const url = `${getPlatformUrl()}/v1/skills/`;
  const response = await fetch(url, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Platform API error ${response.status}: ${response.statusText}`,
    );
  }

  const manifest = (await response.json()) as CatalogManifest;
  if (!Array.isArray(manifest.skills)) {
    throw new Error("Platform catalog has invalid skills array");
  }
  return manifest.skills;
}

/**
 * Extract all files from a tar archive (uncompressed) into a directory.
 * Returns true if a SKILL.md was found in the archive.
 */
function extractTarToDir(tarBuffer: Buffer, destDir: string): boolean {
  let foundSkillMd = false;
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // End-of-archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) break;

    // Filename (bytes 0-99, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header
      .subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100))
      .toString("utf-8");

    // File type (byte 156): '5' = directory, '0' or '\0' = regular file
    const typeFlag = header[156];

    // File size (bytes 124-135, octal)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // past header

    // Skip directories and empty names
    if (name && typeFlag !== 53 /* '5' */) {
      // Prevent path traversal
      const normalizedName = name.replace(/^\.\//, "");
      if (!normalizedName.startsWith("..") && !normalizedName.includes("/..")) {
        const destPath = join(destDir, normalizedName);
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, tarBuffer.subarray(offset, offset + size));

        if (
          normalizedName === "SKILL.md" ||
          normalizedName.endsWith("/SKILL.md")
        ) {
          foundSkillMd = true;
        }
      }
    }

    // Skip to next header (data padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }
  return foundSkillMd;
}

async function fetchAndExtractSkill(
  skillId: string,
  destDir: string,
): Promise<void> {
  const url = `${getPlatformUrl()}/v1/skills/${encodeURIComponent(skillId)}/`;
  const response = await fetch(url, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch skill "${skillId}": HTTP ${response.status}`,
    );
  }

  const gzipBuffer = Buffer.from(await response.arrayBuffer());
  const tarBuffer = gunzipSync(gzipBuffer);
  const foundSkillMd = extractTarToDir(tarBuffer, destDir);

  if (!foundSkillMd) {
    throw new Error(`SKILL.md not found in archive for "${skillId}"`);
  }
}

// ---------------------------------------------------------------------------
// Managed skill installation
// ---------------------------------------------------------------------------

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

function upsertSkillsIndex(id: string): void {
  const indexPath = getSkillsIndexPath();
  let lines: string[] = [];
  if (existsSync(indexPath)) {
    lines = readFileSync(indexPath, "utf-8").split("\n");
  }

  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[-*]\\s+(?:\`)?${escaped}(?:\`)?\\s*$`);
  if (lines.some((line) => pattern.test(line))) return;

  const nonEmpty = lines.filter((l) => l.trim());
  nonEmpty.push(`- ${id}`);
  const content = nonEmpty.join("\n");
  atomicWriteFile(indexPath, content.endsWith("\n") ? content : content + "\n");
}

function removeSkillsIndexEntry(id: string): void {
  const indexPath = getSkillsIndexPath();
  if (!existsSync(indexPath)) return;

  const lines = readFileSync(indexPath, "utf-8").split("\n");
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[-*]\\s+(?:\`)?${escaped}(?:\`)?\\s*$`);
  const filtered = lines.filter((line) => !pattern.test(line));

  // If nothing changed, skip the write
  if (filtered.length === lines.length) return;

  const content = filtered.join("\n");
  atomicWriteFile(indexPath, content.endsWith("\n") ? content : content + "\n");
}

function uninstallSkillLocally(skillId: string): void {
  const skillDir = join(getSkillsDir(), skillId);

  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${skillId}" is not installed.`);
  }

  rmSync(skillDir, { recursive: true, force: true });
  removeSkillsIndexEntry(skillId);
}

async function installSkillLocally(
  skillId: string,
  catalogEntry: CatalogSkill,
  overwrite: boolean,
): Promise<void> {
  const skillDir = join(getSkillsDir(), skillId);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillId}" is already installed. Use --overwrite to replace it.`,
    );
  }

  mkdirSync(skillDir, { recursive: true });

  // In dev mode, install from the local repo skills directory if available
  const repoSkillsDir = getRepoSkillsDir();
  const repoSkillSource = repoSkillsDir
    ? join(repoSkillsDir, skillId)
    : undefined;

  if (repoSkillSource && existsSync(join(repoSkillSource, "SKILL.md"))) {
    cpSync(repoSkillSource, skillDir, { recursive: true });
  } else {
    await fetchAndExtractSkill(skillId, skillDir);
  }

  // Write version metadata
  if (catalogEntry.version) {
    const meta = {
      version: catalogEntry.version,
      installedAt: new Date().toISOString(),
    };
    atomicWriteFile(
      join(skillDir, "version.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  }

  // Install npm dependencies if the skill has a package.json
  if (existsSync(join(skillDir, "package.json"))) {
    const bunPath = `${process.env.HOME || "/root"}/.bun/bin`;
    execSync("bun install", {
      cwd: skillDir,
      stdio: "inherit",
      env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
    });
  }

  // Register in SKILLS.md only after all steps succeed
  upsertSkillsIndex(skillId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum skills <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  list                             List available catalog skills",
  );
  console.log(
    "  install <skill-id> [--overwrite]  Install a skill from the catalog",
  );
  console.log(
    "  uninstall <skill-id>              Uninstall a previously installed skill",
  );
  console.log("");
  console.log("Options:");
  console.log("  --json    Machine-readable JSON output");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function skills(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];
  const json = hasFlag(args, "--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "list": {
      try {
        const catalog = await fetchCatalog();

        // In dev mode, merge in skills from the repo-local skills/ directory
        const repoSkillsDir = getRepoSkillsDir();
        if (repoSkillsDir) {
          const localSkills = readLocalCatalog(repoSkillsDir);
          const remoteIds = new Set(catalog.map((s) => s.id));
          for (const local of localSkills) {
            if (!remoteIds.has(local.id)) {
              catalog.push(local);
            }
          }
        }

        if (json) {
          console.log(JSON.stringify({ ok: true, skills: catalog }));
          return;
        }

        if (catalog.length === 0) {
          console.log("No skills available in the catalog.");
          return;
        }

        console.log(`Available skills (${catalog.length}):\n`);
        for (const s of catalog) {
          const emoji = s.emoji ? `${s.emoji} ` : "";
          const deps = s.includes?.length
            ? ` (requires: ${s.includes.join(", ")})`
            : "";
          console.log(`  ${emoji}${s.id}`);
          console.log(`    ${s.name} — ${s.description}${deps}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    case "install": {
      const skillId = args.find((a) => !a.startsWith("--") && a !== "install");
      if (!skillId) {
        console.error("Usage: vellum skills install <skill-id>");
        process.exit(1);
      }

      const overwrite = hasFlag(args, "--overwrite");

      try {
        // In dev mode, also check the repo-local skills/ directory
        const repoSkillsDir = getRepoSkillsDir();
        let localSkills: CatalogSkill[] = [];
        if (repoSkillsDir) {
          localSkills = readLocalCatalog(repoSkillsDir);
        }

        // Check local catalog first, then fall back to remote
        let entry = localSkills.find((s) => s.id === skillId);
        if (!entry) {
          const catalog = await fetchCatalog();
          entry = catalog.find((s) => s.id === skillId);
        }

        if (!entry) {
          throw new Error(`Skill "${skillId}" not found in the Vellum catalog`);
        }

        // Fetch, extract, and install
        await installSkillLocally(skillId, entry, overwrite);

        if (json) {
          console.log(JSON.stringify({ ok: true, skillId }));
        } else {
          console.log(`Installed skill "${skillId}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    case "uninstall": {
      const skillId = args.find(
        (a) => !a.startsWith("--") && a !== "uninstall",
      );
      if (!skillId) {
        console.error("Usage: vellum skills uninstall <skill-id>");
        process.exit(1);
      }

      try {
        uninstallSkillLocally(skillId);

        if (json) {
          console.log(JSON.stringify({ ok: true, skillId }));
        } else {
          console.log(`Uninstalled skill "${skillId}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    default: {
      console.error(`Unknown skills subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
