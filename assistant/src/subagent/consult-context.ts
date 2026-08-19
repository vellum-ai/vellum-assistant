/**
 * Assemble the runtime context the advisor consult needs to make grounded
 * recommendations, the same situational awareness the executing agent has:
 *  - the tools available to it this turn,
 *  - the full catalog of skills it can load,
 *  - the workspace around it: top-level context, a bounded directory tree of
 *    its working dir, NOW.md, and open documents.
 *
 * The advisor receives the agent's written brief; this adds the situational
 * context the brief cannot state for itself (tools and skills are passed to a
 * model as a separate catalog, not as prose). Without it the advisor cannot
 * reference platform capabilities: it would advise an agent whose toolbox it
 * has never seen. Memory surfaces owned by the memory plugin (PKB, recall
 * search) are deliberately absent because host code must not import plugin
 * internals; anything from memory that bears on the advice has to reach the
 * advisor through the brief.
 *
 * NOW.md is a personal-memory surface, gated to the same policy the main
 * agent's memory injectors apply: `isPersonalMemoryAllowed` plus the
 * scratchpad-injection config toggle. The advisor consult is low-risk and can
 * run on remote/trusted-contact turns, so without the gate it could forward
 * private content the main agent itself would not receive.
 *
 * Every section is best-effort: each source is wrapped so a failure or empty
 * result drops just that section, never the consult. Daemon-, tool-, and
 * memory-side modules are pulled in via dynamic `import()` so this module,
 * reached from a tool executor (`tools/subagent/spawn.ts`), never forms a
 * static import cycle back through the tool registry or plugin bootstrap. The
 * result is a single string carried in the advisor's request turn (see
 * `advisorRequestText`), or `null` when nothing could be gathered.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { SkillSummary } from "../config/skills.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { truncate as truncateText } from "../util/truncate.js";

export interface AdvisorContextSources {
  conversationId: string;
  workingDir: string;
  /** The live tool set the executor sees this turn (`ToolContext.allowedToolNames`). */
  allowedToolNames?: ReadonlySet<string>;
  /**
   * Trust class of the turn's actor, from the per-turn `ToolContext.trustClass`
   * snapshot. Gates the personal-memory surfaces, evaluated exactly as the
   * injectors do and off the same per-turn snapshot rather than the mutable
   * live conversation trust.
   */
  trustClass: TrustClass;
  /**
   * Per-chat plugin scope from `ToolContext.enabledPluginSet`: `null` means no
   * restriction; otherwise plugin-owned skills outside the set are omitted
   * from the catalog section, mirroring the `skill_load` gate.
   */
  enabledPluginSet?: ReadonlySet<string> | null;
  /**
   * Pre-resolved skill catalog, typically the parent conversation's warm
   * `skillProjectionCache.catalog`. Passing it keeps the synchronous on-disk
   * catalog scan out of the consult path (and matches the catalog view the
   * parent turn's tool projection used). When absent, the section falls back
   * to a fresh `loadSkillCatalog()` scan, the same call every agent turn's
   * projection already makes.
   */
  skillCatalog?: readonly SkillSummary[];
}

/** Cap a block so the assembled context never balloons the consult prompt. */
function truncate(text: string, max: number): string {
  return truncateText(text.trim(), max, "…");
}

/** First sentence (or a capped prefix) of a tool/skill description. */
function summarize(description: string | undefined, max = 160): string {
  if (!description) {
    return "";
  }
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return truncate(firstSentence, max);
}

/** `## Available tools`: the live tool set the agent can act with this turn. */
async function buildToolsSection(
  allowedToolNames: ReadonlySet<string> | undefined,
): Promise<string | null> {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  try {
    const { getTool } = await import("../tools/registry.js");
    const lines: string[] = [];
    for (const name of [...allowedToolNames].sort()) {
      const summary = summarize(getTool(name)?.description);
      lines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
    }
    if (lines.length === 0) {
      return null;
    }
    return `## Available tools (what the agent can do)\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * `## Available skills`: every skill the agent can load via `skill_load`.
 * The full catalog is included (one summarized line per skill) so the advisor
 * can point the agent at any existing capability instead of letting it
 * reinvent one. Skills the conversation cannot actually load are omitted,
 * mirroring the `skill_load` gates: plugin-owned skills outside the per-chat
 * plugin scope and skills whose feature flag is off.
 */
async function buildSkillsSection(
  enabledPluginSet: ReadonlySet<string> | null | undefined,
  preResolvedCatalog: readonly SkillSummary[] | undefined,
): Promise<string | null> {
  try {
    const [
      { loadSkillCatalog },
      { skillFlagKey },
      { isAssistantFeatureFlagEnabled },
      { getConfig },
    ] = await Promise.all([
      import("../config/skills.js"),
      import("../config/skill-state.js"),
      import("../config/assistant-feature-flags.js"),
      import("../config/loader.js"),
    ]);
    const config = getConfig();
    const pluginScope = enabledPluginSet ?? null;
    const catalog = (preResolvedCatalog ?? loadSkillCatalog()).filter(
      (skill) => {
        if (
          pluginScope !== null &&
          skill.owner?.kind === "plugin" &&
          !pluginScope.has(skill.owner.id)
        ) {
          return false;
        }
        const flagKey = skillFlagKey(skill);
        return !flagKey || isAssistantFeatureFlagEnabled(flagKey, config);
      },
    );
    if (catalog.length === 0) {
      return null;
    }
    const lines = catalog.map((skill) => {
      const summary = summarize(skill.description);
      const when = skill.activationHints?.length
        ? ` (use when: ${truncate(skill.activationHints.join("; "), 120)})`
        : "";
      const label = skill.displayName || skill.name || skill.id;
      return `- ${label} (${skill.id})${summary ? `: ${summary}` : ""}${when}`;
    });
    return `## Available skills (load with skill_load)\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** Directories that add noise, not signal, to a workspace tree. */
const TREE_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "venv",
]);

const TREE_MAX_DEPTH = 4;
const TREE_MAX_LINES = 300;
const TREE_MAX_ENTRIES_PER_DIR = 40;

/**
 * A bounded, indented listing of the agent's working directory so the advisor
 * sees what actually exists on disk, not just the top-level summary. Dotfiles
 * and dependency/output directories are skipped; each directory lists at most
 * {@link TREE_MAX_ENTRIES_PER_DIR} entries and the whole tree is capped at
 * {@link TREE_MAX_LINES} lines.
 */
export async function buildWorkspaceTree(
  root: string,
  maxDepth = TREE_MAX_DEPTH,
  maxLines = TREE_MAX_LINES,
): Promise<string | null> {
  const lines: string[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || lines.length >= maxLines) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          !(e.isDirectory() && TREE_SKIP_DIRS.has(e.name)),
      )
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      );
    const shown = visible.slice(0, TREE_MAX_ENTRIES_PER_DIR);
    for (const entry of shown) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const indent = "  ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        await walk(join(dir, entry.name), depth + 1);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
    if (visible.length > shown.length) {
      lines.push(
        `${"  ".repeat(depth)}…and ${visible.length - shown.length} more`,
      );
    }
  };

  await walk(root, 0);
  if (lines.length === 0) {
    return null;
  }
  if (truncated || lines.length >= maxLines) {
    lines.push("…(tree truncated)");
  }
  return lines.join("\n");
}

/**
 * Whether personal-memory surfaces (NOW.md) may be exposed to the advisor,
 * the same `isPersonalMemoryAllowed` gate the runtime memory injectors apply.
 *
 * Derived from the per-turn trust snapshot (`ToolContext.trustClass` /
 * `executionChannel`, threaded in via {@link AdvisorContextSources}), NOT the
 * live `findConversation().trustContext`: that conversation state is mutable
 * and a concurrent guardian/meta command could flip it to guardian mid-flight,
 * granting a remote/non-guardian turn access its own snapshot was never given.
 * Fail-closed: if the gate can't be resolved, returns false.
 */
async function personalMemoryAllowedForAdvisor(
  trustClass: TrustClass,
): Promise<boolean> {
  try {
    const { isPersonalMemoryAllowed } =
      await import("../daemon/trust-context.js");
    // The gate decides from the trust class alone, so the per-turn snapshot's
    // class is the whole input.
    const snapshot = { trustClass } as TrustContext;
    return isPersonalMemoryAllowed(snapshot);
  } catch {
    return false;
  }
}

/** `## Workspace & project context`: the loaded environment around the agent. */
async function buildWorkspaceSection(
  sources: AdvisorContextSources,
): Promise<string | null> {
  const { conversationId } = sources;
  const parts: string[] = [];

  // The `<workspace>` directory listing is not personal memory (the agent's
  // own file tools already operate in this cwd), so it is surfaced ungated, the
  // same way the workspace-context injector does. Same for the deeper tree.
  try {
    const { resolveWorkspaceTopLevelContext } =
      await import("../daemon/conversation-workspace.js");
    const workspace = resolveWorkspaceTopLevelContext(conversationId);
    if (workspace) {
      parts.push(truncate(workspace, 4000));
    }
  } catch {
    /* best-effort */
  }

  try {
    const tree = await buildWorkspaceTree(sources.workingDir);
    if (tree) {
      parts.push(
        `Working directory contents (${sources.workingDir}):\n${truncate(tree, 8000)}`,
      );
    }
  } catch {
    /* best-effort */
  }

  // NOW.md and PKB are personal-memory surfaces. Gate them behind the same
  // `isPersonalMemoryAllowed` policy (and, for NOW.md, the scratchpad-injection
  // toggle) the runtime injectors use, evaluated off the per-turn trust
  // snapshot, so a low-risk advisor consult cannot forward private content the
  // main agent would never receive.
  if (await personalMemoryAllowedForAdvisor(sources.trustClass)) {
    try {
      const [{ readNowScratchpad }, { getConfig }] = await Promise.all([
        import("../daemon/now-scratchpad.js"),
        import("../config/loader.js"),
      ]);
      if (getConfig().memory.retrieval.scratchpadInjection.enabled) {
        const now = readNowScratchpad();
        if (now) {
          parts.push(`NOW.md scratchpad:\n${truncate(now, 2000)}`);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  try {
    const { buildActiveDocuments } =
      await import("../daemon/conversation-runtime-assembly.js");
    const docs = buildActiveDocuments(conversationId);
    if (docs && docs.length > 0) {
      const titles = docs
        .slice(0, 20)
        .map((doc) => `- ${doc.title} (${doc.wordCount} words)`)
        .join("\n");
      parts.push(`Open documents:\n${titles}`);
    }
  } catch {
    /* best-effort */
  }

  if (parts.length === 0) {
    return null;
  }
  return `## Workspace & project context\n${parts.join("\n\n")}`;
}

/**
 * Per-section deadline. A source that stalls (e.g. a workspace scan on a slow
 * volume) must cost the consult at most this long and drop only its own
 * section: the advisor is blocking, so context assembly can never be allowed
 * to hang the turn.
 */
const SECTION_TIMEOUT_MS = 2_000;

/**
 * Aggregate ceiling for the assembled pack. The skill catalog scales with the
 * installation, so without a total bound a skill-heavy install could crowd the
 * agent's own brief out of the provider context window.
 */
const TOTAL_CONTEXT_MAX_CHARS = 24_000;

function withSectionTimeout(
  section: Promise<string | null>,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([section, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Gather the advisor's runtime context block, or `null` if nothing is
 * available. Sections run concurrently; each is independently best-effort and
 * bounded by {@link SECTION_TIMEOUT_MS}.
 */
export async function buildAdvisorContext(
  sources: AdvisorContextSources,
  sectionTimeoutMs = SECTION_TIMEOUT_MS,
): Promise<string | null> {
  const sections = await Promise.all(
    [
      buildToolsSection(sources.allowedToolNames),
      buildSkillsSection(sources.enabledPluginSet, sources.skillCatalog),
      buildWorkspaceSection(sources),
    ].map((section) => withSectionTimeout(section, sectionTimeoutMs)),
  );
  const present = sections.filter((s): s is string => s !== null);
  return present.length > 0
    ? truncate(present.join("\n\n"), TOTAL_CONTEXT_MAX_CHARS)
    : null;
}
