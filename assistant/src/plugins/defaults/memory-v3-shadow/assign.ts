/**
 * v3 page→leaf classifier: assigns pages to leaf topics and UNIONS the result
 * into each page's `leaves:` frontmatter.
 *
 * This ports an offline classifier into a daemon module. For each target page
 * it runs a single tool-forced LLM call against the cache-stable numbered leaf
 * index (system prompt) with the page content in the user message, maps the
 * returned 1-based ids back to leaf paths, and writes back the UNION of the
 * page's existing picks and the freshly classified picks.
 *
 * Recall-safe by construction:
 * - UNION semantics never drop a page's existing leaf assignments.
 * - A classification that fails (provider unavailable/throws, no tool use, or
 *   empty result) leaves the page's `leaves:` frontmatter UNCHANGED.
 *
 * Provider-injectable: pass `opts.provider` to bypass the configured-provider
 * lookup (used by tests and callers that force a specific provider). When
 * omitted, resolves the `memoryV3RouteL1` callsite provider.
 */

import { listPages, readPage, writePage } from "../../../memory/v2/page-store.js";
import type { ConceptPage } from "../../../memory/v2/types.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../../providers/provider-send-message.js";
import type { Provider, ToolDefinition } from "../../../providers/types.js";
import { getLogger } from "../../../util/logger.js";
import type { LeafPath, LeafTree, Slug } from "./types.js";

const log = getLogger("memory-v3-assign");

const ASSIGN_TOOL_NAME = "assign_leaves";

/** Default delay between classification calls to avoid hammering the provider. */
const DEFAULT_THROTTLE_MS = 200;

/** Description length cap in the cache-stable leaf index lines. */
const DESCRIPTION_CAP = 450;

/** Bounded output budget — the tool only emits a small id array. */
const MAX_TOKENS = 512;

export interface AssignPagesOptions {
  /** The leaf tree the page is classified against. */
  tree: LeafTree;
  /** Workspace root; pages live under `<workspaceDir>/memory/concepts/`. */
  workspaceDir: string;
  /**
   * Slugs to classify. When omitted, defaults to every page whose `leaves:`
   * frontmatter is empty or missing (the unclassified set).
   */
  slugs?: Slug[];
  /**
   * Provider override. When omitted, resolves the `memoryV3RouteL1` callsite
   * provider once and reuses it across all pages.
   */
  provider?: Provider;
  /** Delay between calls in ms. Defaults to {@link DEFAULT_THROTTLE_MS}. */
  throttleMs?: number;
}

/** Per-page classification outcome, for the job + health report to consume. */
export interface AssignPageResult {
  slug: Slug;
  /** The page's leaf assignments before this run. */
  before: LeafPath[];
  /** The page's leaf assignments after this run (== before when failed). */
  after: LeafPath[];
  /** True when classification failed and the page was left unchanged. */
  failed: boolean;
}

/**
 * Build the cache-stable system prompt: a numbered list of every leaf path with
 * its (trimmed) description. Stable ordering (sorted by path) keeps the prompt
 * prefix identical across calls so the provider can cache it.
 */
function buildLeafIndexSystemPrompt(
  sortedLeafPaths: LeafPath[],
  tree: LeafTree,
): string {
  const lines = sortedLeafPaths.map((path, i) => {
    const description = tree.leaves.get(path)?.description.trim() ?? "";
    const summary = description.slice(0, DESCRIPTION_CAP);
    return `[${i + 1}] ${path} — ${summary}`;
  });
  return [
    "You are a memory classifier. Given a page's content, pick the leaf topics",
    "the page belongs to. A page may belong to several leaves; pick every leaf",
    "whose topic the page meaningfully covers. Return the leaf numbers via the",
    "assign_leaves tool.",
    "",
    "Leaf index:",
    ...lines,
  ].join("\n");
}

const ASSIGN_TOOL: ToolDefinition = {
  name: ASSIGN_TOOL_NAME,
  description: "Return the leaf numbers this page belongs to.",
  input_schema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "integer" },
      },
    },
  },
};

/** Map 1-based ids to sorted leaf paths, dropping out-of-range/0/non-integer ids. */
function idsToLeafPaths(ids: unknown, sortedLeafPaths: LeafPath[]): LeafPath[] {
  if (!Array.isArray(ids)) return [];
  const out: LeafPath[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const idx = id - 1;
    if (idx < 0 || idx >= sortedLeafPaths.length) continue;
    const leafPath = sortedLeafPaths[idx];
    if (!out.includes(leafPath)) out.push(leafPath);
  }
  return out;
}

/** Stable union of two leaf-path lists (existing order first, then new). */
function unionLeafPaths(existing: LeafPath[], added: LeafPath[]): LeafPath[] {
  const out = [...existing];
  for (const leaf of added) {
    if (!out.includes(leaf)) out.push(leaf);
  }
  return out;
}

/** A page's existing `leaves:` frontmatter, or `[]` when empty/missing. */
function pageLeaves(page: ConceptPage): LeafPath[] {
  return page.frontmatter.leaves ?? [];
}

/** The flat text a page contributes to the classifier user message. */
function pageClassifierInput(page: ConceptPage): string {
  const { summary } = page.frontmatter;
  return [summary ?? "", page.body]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classify pages into leaf topics and UNION the result into each page's
 * `leaves:` frontmatter. See the module docstring for the recall-safety
 * guarantees.
 */
export async function assignPages(
  opts: AssignPagesOptions,
): Promise<AssignPageResult[]> {
  const { tree, workspaceDir } = opts;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;

  const sortedLeafPaths = [...tree.leaves.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const systemPrompt = buildLeafIndexSystemPrompt(sortedLeafPaths, tree);

  const targetSlugs = opts.slugs ?? (await unclassifiedSlugs(workspaceDir));

  // Resolve the provider once and reuse it across pages.
  const provider =
    opts.provider ?? (await getConfiguredProvider("memoryV3RouteL1"));

  const results: AssignPageResult[] = [];
  for (let i = 0; i < targetSlugs.length; i++) {
    const slug = targetSlugs[i];
    const page = await readPage(workspaceDir, slug);
    if (!page) {
      log.warn({ slug }, "assign: page not found, skipping");
      results.push({ slug, before: [], after: [], failed: true });
      continue;
    }

    const before = pageLeaves(page);

    if (!provider) {
      log.warn(
        { slug },
        "assign: no provider available, leaving page unchanged",
      );
      results.push({ slug, before, after: before, failed: true });
      continue;
    }

    const classified = await classifyPage(
      provider,
      systemPrompt,
      pageClassifierInput(page),
      sortedLeafPaths,
    );

    if (!classified) {
      // Non-destructive: leave the page's existing picks untouched.
      results.push({ slug, before, after: before, failed: true });
    } else {
      const after = unionLeafPaths(before, classified);
      if (after.length !== before.length) {
        await writePage(workspaceDir, {
          ...page,
          frontmatter: { ...page.frontmatter, leaves: after },
        });
      }
      results.push({ slug, before, after, failed: false });
    }

    if (throttleMs > 0 && i < targetSlugs.length - 1) {
      await sleep(throttleMs);
    }
  }

  return results;
}

/** Pages whose `leaves:` frontmatter is empty or missing — the default targets. */
async function unclassifiedSlugs(workspaceDir: string): Promise<Slug[]> {
  const slugs = await listPages(workspaceDir);
  const unclassified: Slug[] = [];
  for (const slug of slugs) {
    const page = await readPage(workspaceDir, slug);
    if (page && pageLeaves(page).length === 0) unclassified.push(slug);
  }
  return unclassified;
}

/**
 * Run a single tool-forced classification call. Returns the classified leaf
 * paths, or `null` when the call fails (throws, no tool use, or empty ids) so
 * the caller can treat it as non-destructive.
 */
async function classifyPage(
  provider: Provider,
  systemPrompt: string,
  pageInput: string,
  sortedLeafPaths: LeafPath[],
): Promise<LeafPath[] | null> {
  let response;
  try {
    response = await provider.sendMessage([userMessage(pageInput)], {
      systemPrompt,
      tools: [ASSIGN_TOOL],
      config: {
        callSite: "memoryV3RouteL1",
        maxTokens: MAX_TOKENS,
        tool_choice: { type: "tool", name: ASSIGN_TOOL_NAME },
      },
    });
  } catch (err) {
    log.warn({ err }, "assign: classification provider call failed");
    return null;
  }

  const toolUse = extractToolUse(response);
  if (!toolUse || toolUse.name !== ASSIGN_TOOL_NAME) return null;

  const leafPaths = idsToLeafPaths(toolUse.input.ids, sortedLeafPaths);
  return leafPaths.length > 0 ? leafPaths : null;
}
