import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

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
    process.env.VELLUM_ASSISTANT_getPlatformUrl() ??
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
    throw new Error(`Platform API error ${response.status}: ${response.statusText}`);
  }

  const manifest = (await response.json()) as CatalogManifest;
  if (!Array.isArray(manifest.skills)) {
    throw new Error("Platform catalog has invalid skills array");
  }
  return manifest.skills;
}

/**
 * Extract SKILL.md content from a tar archive (uncompressed).
 */
function extractSkillMdFromTar(tarBuffer: Buffer): string | null {
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

    // File size (bytes 124-135, octal)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // past header

    if (name.endsWith("SKILL.md") || name === "SKILL.md") {
      return tarBuffer.subarray(offset, offset + size).toString("utf-8");
    }

    // Skip to next header (data padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
}

async function fetchSkillContent(skillId: string): Promise<string> {
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
  const skillMd = extractSkillMdFromTar(tarBuffer);

  if (!skillMd) {
    throw new Error(`SKILL.md not found in archive for "${skillId}"`);
  }

  return skillMd;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal inline version)
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  fields: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const fields: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n").trimStart();
  return { fields, body };
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

function installSkillLocally(
  skillId: string,
  skillMdContent: string,
  catalogEntry: CatalogSkill,
  overwrite: boolean,
): void {
  const skillDir = join(getSkillsDir(), skillId);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillId}" is already installed. Use --overwrite to replace it.`,
    );
  }

  mkdirSync(skillDir, { recursive: true });
  atomicWriteFile(skillFilePath, skillMdContent);

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
  console.log("  list                             List available catalog skills");
  console.log(
    "  install <skill-id> [--overwrite]  Install a skill from the catalog",
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
        // Verify skill exists in catalog
        const catalog = await fetchCatalog();
        const entry = catalog.find((s) => s.id === skillId);
        if (!entry) {
          throw new Error(`Skill "${skillId}" not found in the Vellum catalog`);
        }

        // Fetch SKILL.md from platform
        const content = await fetchSkillContent(skillId);

        // Install locally
        installSkillLocally(skillId, content, entry, overwrite);

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

    default: {
      console.error(`Unknown skills subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
