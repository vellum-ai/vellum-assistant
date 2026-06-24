/**
 * Assemble the runtime context the advisor needs to make grounded
 * recommendations — the same situational awareness the executing agent has:
 *  - the tools available to it this turn,
 *  - the skills it can load,
 *  - the loaded workspace / project context, NOW.md, PKB, and open documents,
 *  - and relevant memory pulled through the recall search.
 *
 * The advisor already receives the agent's transcript and system prompt; this
 * adds the situational context that lives *outside* the prompt (tools and
 * skills are passed to the model as a separate catalog, not inlined) plus a
 * fresh, task-focused memory recall.
 *
 * Personal-memory surfaces are gated to the same policy the main agent's
 * memory injectors apply: the recall search honors `canAccessMemory` (like the
 * `recall` tool), and NOW.md / PKB honor `isPersonalMemoryAllowed` (plus the
 * scratchpad-injection toggle for NOW.md). The advisor tool is low-risk and can
 * run on remote/trusted-contact turns, so without these gates it could forward
 * private content the main agent itself would not receive.
 *
 * Every section is best-effort: each source is wrapped so a failure or empty
 * result drops just that section, never the consult. Daemon- and memory-side
 * modules are pulled in via dynamic `import()` so this plugin module — loaded
 * at bootstrap through `defaults/index.ts` — never forms a static import cycle
 * with them. The result is a single string injected into the advisor's system
 * prompt (see `buildAdvisorSystem`), or `null` when nothing could be gathered.
 */

import type { Message } from "../../../providers/types.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";

export interface AdvisorContextSources {
  conversationId: string;
  workingDir: string;
  /** The live tool set the executor sees this turn (`ToolContext.allowedToolNames`). */
  allowedToolNames?: ReadonlySet<string>;
  /** Trust class of the turn's actor; gates the memory recall. */
  trustClass: TrustClass;
  /** The captured transcript, used to derive the recall query. */
  transcript: ReadonlyArray<Message>;
  signal?: AbortSignal;
}

/** Cap a block so the assembled context never balloons the consult prompt. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** First sentence (or a capped prefix) of a tool/skill description. */
function summarize(description: string | undefined, max = 160): string {
  if (!description) return "";
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return truncate(firstSentence, max);
}

/** Pull the most recent user-authored text to seed the memory recall query. */
export function deriveRecallQuery(
  transcript: ReadonlyArray<Message>,
): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i];
    if (message.role !== "user") continue;
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .trim();
    if (text.length > 0) return truncate(text, 500);
  }
  return null;
}

/** `## Available tools` — the live tool set the agent can act with this turn. */
async function buildToolsSection(
  allowedToolNames: ReadonlySet<string> | undefined,
): Promise<string | null> {
  if (!allowedToolNames || allowedToolNames.size === 0) return null;
  try {
    const { getTool } = await import("../../../tools/registry.js");
    const lines: string[] = [];
    for (const name of [...allowedToolNames].sort()) {
      // The advisor advises; it never recommends consulting itself.
      if (name === "advisor") continue;
      const summary = summarize(getTool(name)?.description);
      lines.push(summary ? `- ${name} — ${summary}` : `- ${name}`);
    }
    if (lines.length === 0) return null;
    return `## Available tools (what the agent can do)\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** `## Available skills` — the skills the agent can load via `skill_load`. */
async function buildSkillsSection(): Promise<string | null> {
  try {
    const { loadSkillCatalog } = await import("../../../config/skills.js");
    const catalog = loadSkillCatalog();
    if (catalog.length === 0) return null;
    const lines = catalog.slice(0, 60).map((skill) => {
      const summary = summarize(skill.description);
      const when = skill.activationHints?.length
        ? ` (use when: ${truncate(skill.activationHints.join("; "), 120)})`
        : "";
      const label = skill.displayName || skill.name || skill.id;
      return `- ${label} (${skill.id})${summary ? ` — ${summary}` : ""}${when}`;
    });
    const more =
      catalog.length > 60 ? `\n- …and ${catalog.length - 60} more` : "";
    return `## Available skills (load with skill_load)\n${lines.join("\n")}${more}`;
  } catch {
    return null;
  }
}

/**
 * Whether personal-memory surfaces (NOW.md, PKB) may be exposed to the advisor
 * for this conversation — the same `isPersonalMemoryAllowed` gate the runtime
 * memory injectors apply, resolved from the conversation's trust context. The
 * advisor tool is low-risk and can run on remote/trusted-contact turns, so
 * these surfaces must be gated exactly as the main agent's injectors gate them.
 * Fail-closed: if the gate or trust can't be resolved, returns false.
 */
async function personalMemoryAllowedForAdvisor(
  conversationId: string,
): Promise<boolean> {
  try {
    const [{ findConversation }, { isPersonalMemoryAllowed }] =
      await Promise.all([
        import("../../../daemon/conversation-registry.js"),
        import("../../../daemon/trust-context.js"),
      ]);
    return isPersonalMemoryAllowed(
      findConversation(conversationId)?.trustContext,
    );
  } catch {
    return false;
  }
}

/** `## Workspace & project context` — the loaded environment around the agent. */
async function buildWorkspaceSection(
  conversationId: string,
): Promise<string | null> {
  const parts: string[] = [];

  // The `<workspace>` directory listing is not personal memory — the agent's
  // own file tools already operate in this cwd — so it is surfaced ungated, the
  // same way the workspace-context injector does.
  try {
    const { resolveWorkspaceTopLevelContext } =
      await import("../../../daemon/conversation-workspace.js");
    const workspace = resolveWorkspaceTopLevelContext(conversationId);
    if (workspace) parts.push(truncate(workspace, 2500));
  } catch {
    /* best-effort */
  }

  // NOW.md and PKB are personal-memory surfaces. Gate them behind the same
  // `isPersonalMemoryAllowed` policy (and, for NOW.md, the scratchpad-injection
  // toggle) the runtime injectors use, so a low-risk advisor consult cannot
  // forward private content the main agent would never receive.
  if (await personalMemoryAllowedForAdvisor(conversationId)) {
    try {
      const [{ readNowScratchpad }, { getConfig }] = await Promise.all([
        import("../../../daemon/now-scratchpad.js"),
        import("../../../config/loader.js"),
      ]);
      if (getConfig().memory.retrieval.scratchpadInjection.enabled) {
        const now = readNowScratchpad();
        if (now) parts.push(`NOW.md scratchpad:\n${truncate(now, 1500)}`);
      }
    } catch {
      /* best-effort */
    }

    try {
      const { readPkbContext } = await import("../../../memory/pkb/context.js");
      const pkb = readPkbContext();
      if (pkb) parts.push(truncate(pkb, 1500));
    } catch {
      /* best-effort */
    }
  }

  try {
    const { buildActiveDocuments } =
      await import("../../../daemon/conversation-runtime-assembly.js");
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

  if (parts.length === 0) return null;
  return `## Workspace & project context\n${parts.join("\n\n")}`;
}

/** `## Relevant memory (recall)` — a fresh, task-focused recall search. */
async function buildMemorySection(
  sources: AdvisorContextSources,
): Promise<string | null> {
  try {
    const { resolveCapabilities } =
      await import("../../../runtime/capabilities.js");
    // Recall reads sensitive local context; honor the same trust gate the
    // `recall` tool applies. Non-guardian turns get no fresh recall here.
    if (!resolveCapabilities(sources.trustClass).canAccessMemory) return null;

    const query = deriveRecallQuery(sources.transcript);
    if (!query) return null;

    const [{ runDeterministicRecallSearch }, { getConfig }] = await Promise.all(
      [
        import("../../../memory/context-search/search.js"),
        import("../../../config/loader.js"),
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
    if (evidence.length === 0) return null;

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
 * Gather the advisor's runtime context block, or `null` if nothing is
 * available. Sections run concurrently; each is independently best-effort.
 */
export async function buildAdvisorContext(
  sources: AdvisorContextSources,
): Promise<string | null> {
  const sections = await Promise.all([
    buildToolsSection(sources.allowedToolNames),
    buildSkillsSection(),
    buildWorkspaceSection(sources.conversationId),
    buildMemorySection(sources),
  ]);
  const present = sections.filter((s): s is string => s !== null);
  return present.length > 0 ? present.join("\n\n") : null;
}
