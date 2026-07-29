/**
 * `assistant memory ingest` subcommand.
 *
 * Batch-ingests fully-formed concept pages (frontmatter + body markdown)
 * straight into memory/concepts/ via the daemon's `memory_ingest` route,
 * bypassing the consolidation buffer. Input comes from a staging directory
 * of .md files (--dir), a JSON manifest file (--file), or piped stdin.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import type { MemoryIngestResult } from "../../../plugins/defaults/memory/src/memory-ingest-routes.js";
import { readStdinSync } from "../../../util/read-stdin.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";

/**
 * IPC timeout for `ingest`. A batch validates and writes up to 200 pages
 * under the consolidation lock and enqueues reindex follow-up jobs, which
 * can outlast `cliIpcCall`'s default 60s on large batches, so allow a
 * generous 5-minute ceiling per batch rather than report a spurious
 * "Request timed out" while the assistant keeps working.
 */
const INGEST_IPC_TIMEOUT_MS = 5 * 60 * 1000;

/** Pages per `memory_ingest` call (the route caps a request at 200 pages). */
const MAX_PAGES_PER_CALL = 200;

interface IngestPage {
  slug: string;
  content: string;
}

/** Recursively collect .md files under `dir`; slug = relative path minus `.md`. */
function walkMarkdownFiles(root: string, dir: string, out: IngestPage[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rel = relative(root, full);
      const slug = rel.slice(0, -".md".length).split(sep).join("/");
      out.push({ slug, content: readFileSync(full, "utf-8") });
    }
  }
}

/** Validate a parsed JSON manifest into pages, with per-index error messages. */
function validateManifest(raw: unknown): IngestPage[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      "Manifest must be a JSON array of { slug, content } objects.",
    );
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Manifest item [${i}] must be an object with string 'slug' and 'content' fields.`,
      );
    }
    const { slug, content } = item as Record<string, unknown>;
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error(
        `Manifest item [${i}].slug is required and must be a non-empty string.`,
      );
    }
    if (typeof content !== "string") {
      throw new Error(
        `Manifest item [${i}].content is required and must be a string (the full page markdown).`,
      );
    }
    return { slug, content };
  });
}

/** Assemble the page list from --dir, --file, or piped stdin. */
function loadPages(opts: { dir?: string; file?: string }): IngestPage[] {
  if (opts.dir !== undefined && opts.file !== undefined) {
    throw new Error(
      "Pass either --dir or --file, not both. Drop one of the two input flags.",
    );
  }
  if (opts.dir !== undefined) {
    let stats;
    try {
      stats = statSync(opts.dir);
    } catch {
      throw new Error(`Directory not found: ${opts.dir}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${opts.dir}`);
    }
    const pages: IngestPage[] = [];
    walkMarkdownFiles(opts.dir, opts.dir, pages);
    pages.sort((a, b) => a.slug.localeCompare(b.slug));
    return pages;
  }
  let raw: string;
  if (opts.file !== undefined) {
    if (!existsSync(opts.file)) {
      throw new Error(`File not found: ${opts.file}`);
    }
    raw = readFileSync(opts.file, "utf-8");
  } else {
    if (process.stdin.isTTY) {
      throw new Error(
        "No input provided. Pipe JSON into stdin or use --file <path> or --dir <path>.",
      );
    }
    raw = readStdinSync();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON manifest: ${msg}`);
  }
  return validateManifest(parsed);
}

/**
 * Reject duplicate slugs across the whole input before chunking. The route's
 * duplicate check is per request, so duplicates that land in different
 * 200-page batches would bypass it: without --overwrite the later copy is
 * misreported as an existing-page skip, and with --overwrite it silently
 * replaces the earlier one.
 */
function assertUniqueSlugs(pages: IngestPage[]): IngestPage[] {
  const firstIndexBySlug = new Map<string, number>();
  const duplicates: string[] = [];
  for (const [index, page] of pages.entries()) {
    const first = firstIndexBySlug.get(page.slug);
    if (first === undefined) {
      firstIndexBySlug.set(page.slug, index);
    } else {
      duplicates.push(
        `"${page.slug}" (entries ${String(first)} and ${String(index)})`,
      );
    }
  }
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate slugs in input: ${duplicates.join(", ")}. ` +
        "Each slug may appear once per ingest.",
    );
  }
  return pages;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export function registerMemoryIngestCommand(memory: Command): void {
  subcommand(memory, "ingest").action(
    async (opts: {
      dir?: string;
      file?: string;
      dryRun?: boolean;
      overwrite?: boolean;
      json?: boolean;
    }) => {
      let pages: IngestPage[];
      try {
        pages = assertUniqueSlugs(loadPages(opts));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json === true) {
          log.info(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      const aggregate: MemoryIngestResult = {
        results: [],
        written: 0,
        skipped: 0,
        invalid: 0,
        dryRun: opts.dryRun === true,
      };

      if (pages.length === 0) {
        if (opts.json === true) {
          log.info(JSON.stringify(aggregate));
        } else {
          log.info("No pages to ingest.");
        }
        return;
      }
      for (const batch of chunk(pages, MAX_PAGES_PER_CALL)) {
        const r = await cliIpcCall<MemoryIngestResult>(
          "memory_ingest",
          {
            body: {
              pages: batch,
              ...(opts.dryRun === true ? { dryRun: true } : {}),
              ...(opts.overwrite === true ? { overwrite: true } : {}),
            },
          },
          { timeoutMs: INGEST_IPC_TIMEOUT_MS },
        );
        if (!r.ok) {
          return exitFromIpcResult(r);
        }
        const payload = r.result!;
        aggregate.results.push(...payload.results);
        aggregate.written += payload.written;
        aggregate.skipped += payload.skipped;
        aggregate.invalid += payload.invalid;
      }

      if (opts.json === true) {
        log.info(JSON.stringify(aggregate));
      } else {
        const verb = aggregate.dryRun ? "Would write" : "Wrote";
        log.info(
          `${verb} ${aggregate.written} page(s); skipped ${aggregate.skipped} existing; ${aggregate.invalid} invalid.`,
        );
        for (const res of aggregate.results) {
          for (const warning of res.warnings) {
            log.warn(`  ${res.slug}: ${warning}`);
          }
          if (res.action === "invalid") {
            log.error(`  invalid ${res.slug}: ${res.error ?? "unknown error"}`);
          }
        }
        if (aggregate.skipped > 0 && opts.overwrite !== true) {
          log.info(
            "Re-run with --overwrite to rewrite pages whose slug already exists.",
          );
        }
      }
      if (aggregate.invalid > 0) {
        process.exitCode = 1;
      }
    },
  );
}
