/**
 * Assemble the runtime context the advisor consult needs to make grounded
 * recommendations — the same situational awareness the executing agent has:
 *  - the tools available to it this turn,
 *  - the full catalog of skills it can load,
 *  - the workspace around it: top-level context, a bounded directory tree of
 *    its working dir, NOW.md, PKB, and open documents,
 *  - and relevant memory pulled through the recall search.
 *
 * The advisor already receives the agent's transcript and system prompt; this
 * adds the situational context that lives *outside* the prompt (tools and
 * skills are passed to the model as a separate catalog, not inlined) plus a
 * fresh, task-focused memory recall. Without it the advisor cannot reference
 * platform capabilities — it would advise an agent whose toolbox it has never
 * seen.
 *
 * Personal-memory surfaces are gated to the same policy the main agent's
 * memory injectors apply: the recall search honors `canAccessMemory` (like the
 * `recall` tool), and NOW.md / PKB honor `isPersonalMemoryAllowed` (plus the
 * scratchpad-injection toggle for NOW.md). The advisor consult is low-risk and
 * can run on remote/trusted-contact turns, so without these gates it could
 * forward private content the main agent itself would not receive.
 *
 * Every section is best-effort: each source is wrapped so a failure or empty
 * result drops just that section, never the consult. Daemon-, tool-, and
 * memory-side modules are pulled in via dynamic `import()` so this module —
 * reached from a tool executor (`tools/subagent/spawn.ts`) — never forms a
 * static import cycle back through the tool registry or plugin bootstrap. The
 * result is a single string appended to the advisor's system prompt (see
 * `buildAdvisorSystem`), or `null` when nothing could be gathered.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ChannelId } from "../channels/types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type { Message } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { truncate as truncateText } from "../util/truncate.js";

export interface AdvisorContextSources {
  conversationId: string;
  workingDir: string;
  /** The live tool set the executor sees this turn (`ToolContext.allowedToolNames`). */
  allowedToolNames?: ReadonlySet<string>;
  /**
   * Trust class of the turn's actor, from the per-turn `ToolContext.trustClass`
   * snapshot. Gates the memory recall and (with {@link sourceChannel}) the
   * personal-memory surfaces.
   */
  trustClass: TrustClass;
  /**
   * Channel the turn originates on, from the per-turn `ToolContext.executionChannel`
   * snapshot. Combined with {@link trustClass} to evaluate personal-memory
   * access exactly as the injectors do, off the same per-turn snapshot rather
   * than the mutable live conversation trust.
   */
  sourceChannel?: string;
  /** The captured transcript, used to derive the recall query. */
  transcript: ReadonlyArray<Message>;
  signal?: AbortSignal;
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

/** Pull the most recent user-authored text to seed the memory recall query. */
export function deriveRecallQuery(
  transcript: ReadonlyArray<Message>,
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.role !== "user") {
      continue;
    }
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .trim();
    if (text.length > 0) {
      return truncate(text, 500);
    }
  }
  return null;
}

/** `## Available tools` — the live tool set the agent can act with this turn. */
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
      lines.push(summary ? `- ${name} — ${summary}` : `- ${name}`);
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
 * `## Available skills` — every skill the agent can load via `skill_load`.
 * The full catalog is included (one summarized line per skill) so the advisor
 * can point the agent at any existing capability instead of letting it
 * reinvent one.
 */
async function buildSkillsSection(): Promise<string | null> {
  try {
    const { loadSkillCatalog } = await import("../config/skills.js");
    const catalog = loadSkillCatalog();
    if (catalog.length === 0) {
      return null;
    }
    const lines = catalog.map((skill) => {
      const summary = summarize(skill.description);
      const when = skill.activationHints?.length
        ? ` (use when: ${truncate(skill.activationHints.join("; "), 120)})`
        : "";
      const label = skill.displayName || skill.name || skill.id;
      return `- ${label} (${skill.id})${summary ? ` — ${summary}` : ""}${when}`;
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
export function buildWorkspaceTree(
  root: string,
  maxDepth = TREE_MAX_DEPTH,
  maxLines = TREE_MAX_LINES,
): string | null {
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || lines.length >= maxLines) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
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
        walk(join(dir, entry.name), depth + 1);
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

  walk(root, 0);
  if (lines.length === 0) {
    return null;
  }
  if (truncated || lines.length >= maxLines) {
    lines.push("…(tree truncated)");
  }
  return lines.join("\n");
}

/**
 * Whether personal-memory surfaces (NOW.md, PKB) may be exposed to the advisor
 * — the same `isPersonalMemoryAllowed` gate the runtime memory injectors apply.
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
  sourceChannel: string | undefined,
): Promise<boolean> {
  try {
    const { isPersonalMemoryAllowed } =
      await import("../daemon/trust-context.js");
    // `isPersonalMemoryAllowed` reads only `sourceChannel` + `trustClass`; build
    // a minimal trust context from the per-turn snapshot. The channel may be
    // absent (local/internal turns), which the gate treats as non-remote.
    const snapshot = {
      sourceChannel: sourceChannel as ChannelId | undefined,
      trustClass,
    } as TrustContext;
    return isPersonalMemoryAllowed(snapshot);
  } catch {
    return false;
  }
}

/** `## Workspace & project context` — the loaded environment around the agent. */
async function buildWorkspaceSection(
  sources: AdvisorContextSources,
): Promise<string | null> {
  const { conversationId } = sources;
  const parts: string[] = [];

  // The `<workspace>` directory listing is not personal memory — the agent's
  // own file tools already operate in this cwd — so it is surfaced ungated, the
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
    const tree = buildWorkspaceTree(sources.workingDir);
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
  if (
    await personalMemoryAllowedForAdvisor(
      sources.trustClass,
      sources.sourceChannel,
    )
  ) {
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

    try {
      const { readPkbContext } =
        await import("../plugins/defaults/memory/v1/pkb/context.js");
      const pkb = readPkbContext();
      if (pkb) {
        parts.push(truncate(pkb, 2000));
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

/** `## Relevant memory (recall)` — a fresh, task-focused recall search. */
async function buildMemorySection(
  sources: AdvisorContextSources,
): Promise<string | null> {
  try {
    const { resolveCapabilities } = await import("../runtime/capabilities.js");
    // Recall reads sensitive local context; honor the same trust gate the
    // `recall` tool applies. Non-guardian turns get no fresh recall here.
    if (!resolveCapabilities(sources.trustClass).canAccessMemory) {
      return null;
    }

    const query = deriveRecallQuery(sources.transcript);
    if (!query) {
      return null;
    }

    const [{ runDeterministicRecallSearch }, { getConfig }] = await Promise.all(
      [
        import("../plugins/defaults/memory/context-search/search.js"),
        import("../config/loader.js"),
      ],
    );

    const { evidence } = await runDeterministicRecallSearch(
      { query, max_results: 8 },
      {
        workingDir: sources.workingDir,
        conversationId: sources.conversationId,
        config: getConfig(),
        signal: sources.signal,
      },
    );
    if (evidence.length === 0) {
      return null;
    }

    const lines = evidence.slice(0, 8).map((item) => {
      const excerpt = truncate(item.excerpt, 220);
      return `- [${item.source}] ${item.title} (${item.locator}): ${excerpt}`;
    });
    return `## Relevant memory (recall: "${truncate(query, 120)}")\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * Per-section deadline. A source that stalls (e.g. a recall search waiting on
 * a subsystem that is down) must cost the consult at most this long and drop
 * only its own section — the advisor is blocking, so context assembly can
 * never be allowed to hang the turn.
 */
const SECTION_TIMEOUT_MS = 2_000;

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
      buildSkillsSection(),
      buildWorkspaceSection(sources),
      buildMemorySection(sources),
    ].map((section) => withSectionTimeout(section, sectionTimeoutMs)),
  );
  const present = sections.filter((s): s is string => s !== null);
  return present.length > 0 ? present.join("\n\n") : null;
}
