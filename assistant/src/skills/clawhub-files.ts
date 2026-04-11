/**
 * clawhub-files — SkillFileProvider implementation for clawhub-origin skills.
 *
 * Backed by the `clawhub inspect` CLI. The initial `clawhubInspect` call
 * fetches file metadata *and* SKILL.md content in a single round trip.
 * Results are cached in memory (5-minute TTL) so that subsequent calls to
 * `listFiles`, `readFileContent`, and `toSlimSkill` for the same slug
 * reuse the inspect data without re-running the CLI.
 *
 * For non-SKILL.md files, `readFileContent` delegates to `clawhubInspectFile`
 * which runs a second CLI call for the specific file.
 */

import { basename } from "node:path";

import type { SlimSkillResponse } from "../daemon/message-types/skills.js";
import { isTextMimeType as isTextMime } from "../runtime/routes/workspace-utils.js";
import { getLogger } from "../util/logger.js";
import type { SkillFileEntry } from "./catalog-files.js";
import {
  clawhubInspect,
  clawhubInspectFile,
  type ClawhubInspectResult,
  validateSlug,
} from "./clawhub.js";
import type { SkillFileProvider } from "./skill-file-provider.js";

const log = getLogger("clawhub-files");

// ─── Inspect cache ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: ClawhubInspectResult;
  expiresAt: number;
}

const inspectCache = new Map<string, CacheEntry>();

function getCached(slug: string): ClawhubInspectResult | null {
  const entry = inspectCache.get(slug);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    inspectCache.delete(slug);
    return null;
  }
  return entry.data;
}

function setCache(slug: string, data: ClawhubInspectResult): void {
  inspectCache.set(slug, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Run `clawhubInspect` with caching. Returns the inspect result or `null`.
 */
async function inspectCached(
  slug: string,
): Promise<ClawhubInspectResult | null> {
  const cached = getCached(slug);
  if (cached) return cached;

  const result = await clawhubInspect(slug);
  if (!result.data) {
    log.warn({ slug, error: result.error }, "clawhub inspect failed");
    return null;
  }
  setCache(slug, result.data);
  return result.data;
}

// ─── Binary classification ───────────────────────────────────────────────────

/**
 * Classify a file as binary from its name and optional contentType field.
 * If the contentType from the inspect result is present and recognised,
 * prefer it; otherwise fall back to Bun's extension-based MIME detection
 * (same strategy as `catalog-files.ts`).
 */
function classifyBinary(fileName: string, contentType?: string): boolean {
  if (contentType) {
    return !isTextMime(contentType, fileName);
  }
  const mime = Bun.file(fileName).type;
  return !isTextMime(mime, fileName);
}

// ─── Provider factory ─────────────────────────────────────────────────────────

/**
 * Create a `SkillFileProvider` for clawhub-origin skills.
 *
 * `canHandle` returns `true` for slugs that pass clawhub's `validateSlug`
 * regex AND do not look like a skills.sh slug (skills.sh slugs have three
 * slash-separated segments: `owner/repo/skill`).
 */
export function createClawhubProvider(): SkillFileProvider {
  return {
    canHandle(skillId: string): boolean {
      if (!validateSlug(skillId)) return false;
      // skills.sh slugs have ≥ 3 segments (owner/repo/skill)
      if (skillId.split("/").length >= 3) return false;
      return true;
    },

    async listFiles(skillId: string): Promise<SkillFileEntry[] | null> {
      const data = await inspectCached(skillId);
      if (!data || !data.files) return null;

      const entries: SkillFileEntry[] = data.files.map((f) => {
        const name = basename(f.path);
        const isBinary = classifyBinary(name, f.contentType);
        return {
          path: f.path,
          name,
          size: f.size,
          mimeType: f.contentType ?? Bun.file(name).type,
          isBinary,
          content: null,
        };
      });
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return entries;
    },

    async readFileContent(
      skillId: string,
      sanitizedPath: string,
    ): Promise<SkillFileEntry | null> {
      // If the requested path is SKILL.md and we have cached inspect data
      // with skillMdContent, return it directly without a second CLI call.
      const cached = getCached(skillId);
      if (
        cached &&
        sanitizedPath === "SKILL.md" &&
        cached.skillMdContent != null
      ) {
        const name = "SKILL.md";
        return {
          path: sanitizedPath,
          name,
          size: cached.skillMdContent.length,
          mimeType: "text/markdown",
          isBinary: false,
          content: cached.skillMdContent,
        };
      }

      const name = basename(sanitizedPath);
      const isBinary = classifyBinary(name);

      // For non-SKILL.md files (or when SKILL.md isn't cached), run
      // a dedicated inspect call for the specific file.
      const content = await clawhubInspectFile(skillId, sanitizedPath);

      // Binary files: return metadata with content: null (matching the
      // contract followed by vellum and skills.sh providers). clawhubInspectFile
      // returns null for binary files, which is expected.
      if (isBinary) {
        // Look up file metadata from cached inspect result if available.
        const inspectData =
          getCached(skillId) ?? (await inspectCached(skillId));
        const fileMeta = inspectData?.files?.find(
          (f) => f.path === sanitizedPath,
        );
        return {
          path: sanitizedPath,
          name,
          size: fileMeta?.size ?? 0,
          mimeType: fileMeta?.contentType ?? Bun.file(name).type,
          isBinary: true,
          content: null,
        };
      }

      // Text file but content fetch failed — file doesn't exist.
      if (content == null) return null;

      return {
        path: sanitizedPath,
        name,
        size: content.length,
        mimeType: Bun.file(name).type,
        isBinary: false,
        content,
      };
    },

    async toSlimSkill(skillId: string): Promise<SlimSkillResponse | null> {
      const data = await inspectCached(skillId);
      if (!data) return null;

      return {
        id: data.skill.slug,
        name: data.skill.displayName,
        description: data.skill.summary,
        kind: "catalog",
        status: "available",
        origin: "clawhub",
        slug: data.skill.slug,
        author: data.owner?.handle ?? "",
        stars: data.stats?.stars ?? 0,
        installs: data.stats?.installs ?? 0,
        reports: 0,
        publishedAt: data.updatedAt
          ? new Date(data.updatedAt).toISOString()
          : undefined,
      };
    },
  };
}
