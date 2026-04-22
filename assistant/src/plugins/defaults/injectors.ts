/**
 * Default runtime injector plugin — the canonical chain of injectors that
 * replaces the hardcoded injection sequence previously baked into
 * `applyRuntimeInjections` (pre-migration).
 *
 * Each of the seven default injectors reads its per-turn inputs from
 * `ctx.injectionInputs` (see {@link TurnInjectionInputs}), runs its gating
 * conditions (injection mode, feature flags, channel type, null-input
 * short-circuits), and returns an {@link InjectionBlock} with a
 * {@link InjectionPlacement} that preserves the byte-for-byte positional
 * semantics of the pre-migration `inject*` helpers:
 *
 * | name                     | order | placement               |
 * | ------------------------ | ----- | ----------------------- |
 * | `workspace-context`      | 10    | prepend-user-tail       |
 * | `unified-turn-context`   | 20    | prepend-user-tail       |
 * | `pkb`                    | 30    | after-memory-prefix     |
 * | `now-md`                 | 40    | after-memory-prefix     |
 * | `subagent-status`        | 50    | append-user-tail        |
 * | `slack-messages`         | 60    | replace-run-messages    |
 * | `thread-focus`           | 70    | append-user-tail        |
 *
 * `order` matches the intended final-content ordering: lower `order` ends
 * up closer to the top of the user message's content (for prepends), closer
 * to the memory prefix (for after-memory-prefix), or earlier in the tail
 * append sequence (for appends). The runtime-injection applier sorts and
 * applies blocks declaratively so this invariant holds even when
 * third-party injectors slot additional blocks at fractional order values.
 *
 * Third-party plugins may register additional {@link Injector}s at any
 * `order` value; the registry's `getInjectors()` returns all injectors
 * sorted ascending, so a plugin-registered injector at `order: 25`
 * reliably slots between `unified-turn-context` (20) and `pkb` (30).
 *
 * Registration happens via a side-effect import in
 * `daemon/external-plugins-bootstrap.ts` so the default chain is present for
 * every assistant boot.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 21 — scaffolding,
 * G2.1 — full migration).
 */

import { resolve } from "node:path";

import { getInContextPkbPaths } from "../../daemon/pkb-context-tracker.js";
import { buildPkbReminder } from "../../daemon/pkb-reminder-builder.js";
import { searchPkbFiles } from "../../memory/pkb/pkb-search.js";
import { getLogger } from "../../util/logger.js";
import type {
  InjectionBlock,
  Injector,
  Plugin,
  TurnContext,
  TurnInjectionInputs,
} from "../types.js";

const pkbReminderLog = getLogger("pkb-reminder");

/** Minimum hybrid-search score for a PKB path to surface as an injection hint. */
const PKB_HINT_THRESHOLD = 0.5;

/**
 * Stricter hint threshold for PKB entries under `archive/`. Archive files are
 * date-indexed dumps of older notes — they match loosely and are rarely the
 * most relevant read, so require a higher bar before recommending them.
 */
const PKB_HINT_ARCHIVE_THRESHOLD = 0.7;

/**
 * Fixed order values for the seven default injectors. Exported so tests —
 * and any future integration code — can assert ordering without re-deriving
 * the constants.
 *
 * Gaps of 10 between slots leave room for third-party injectors to slot in
 * at granular positions (e.g. `25` between unified-turn-context and pkb)
 * without renumbering the defaults.
 */
export const DEFAULT_INJECTOR_ORDER = {
  workspaceContext: 10,
  unifiedTurnContext: 20,
  pkb: 30,
  nowMd: 40,
  subagentStatus: 50,
  slackMessages: 60,
  threadFocus: 70,
} as const satisfies Record<string, number>;

function readInjectionInputs(ctx: TurnContext): TurnInjectionInputs {
  return ctx.injectionInputs ?? {};
}

/**
 * `workspace-context` injector — order 10, prepend-user-tail.
 *
 * Injects the workspace top-level directory context at the very top of the
 * user tail's content so the assistant sees a workspace grounding block
 * before any other per-turn context.
 *
 * Gating:
 *  - `mode === "full"` (skipped in minimal mode).
 *  - `workspaceTopLevelContext` is a non-null, non-empty string.
 */
export const workspaceContextInjector: Injector = {
  name: "workspace-context",
  order: DEFAULT_INJECTOR_ORDER.workspaceContext,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    const text = inputs.workspaceTopLevelContext;
    if (!text) return null;
    return {
      id: "workspace-context",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `unified-turn-context` injector — order 20, prepend-user-tail.
 *
 * Injects the pre-built `<turn_context>` block that combines temporal,
 * actor, channel, and interface context. The orchestrator builds the text
 * via `buildUnifiedTurnContextBlock` before the chain runs and hands it in
 * via `ctx.injectionInputs.unifiedTurnContext`.
 *
 * Active in both `full` and `minimal` mode — unified turn context is
 * safety-critical grounding that must survive injection downgrade.
 */
export const unifiedTurnContextInjector: Injector = {
  name: "unified-turn-context",
  order: DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const text = inputs.unifiedTurnContext;
    if (!text) return null;
    return {
      id: "unified-turn-context",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `pkb` injector — order 30, after-memory-prefix.
 *
 * Combines the `<system_reminder>` (PKB behavioural nudge + hybrid-search
 * hints) and the `<knowledge_base>` block (auto-injected PKB content) into
 * a single block spliced immediately after any leading memory-prefix blocks
 * so the final tail shape reads
 * `[...memory prefix, <system_reminder>, <knowledge_base>, ...user text]`.
 *
 * Emitting both as one block preserves the ordering of the pre-migration
 * two-branch implementation (context splice first, reminder splice second)
 * without requiring two after-memory-prefix splice passes through the
 * message array. Third-party injectors that want to separate the two can
 * do so by omitting the `<system_reminder>` half when overriding.
 *
 * Gating:
 *  - `mode === "full"` for both halves.
 *  - `<knowledge_base>` — non-null `pkbContext`.
 *  - `<system_reminder>` — `pkbActive === true`.
 *  - Returns `null` when neither applies.
 */
export const pkbInjector: Injector = {
  name: "pkb",
  order: DEFAULT_INJECTOR_ORDER.pkb,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;

    const hasContext = !!inputs.pkbContext;
    const hasReminder = !!inputs.pkbActive;
    if (!hasContext && !hasReminder) return null;

    const parts: string[] = [];

    // Reminder appears first in the spliced block (matches pre-migration
    // behaviour where the reminder was inserted second, pushing the
    // previously-inserted context down).
    if (hasReminder) {
      const reminder = await buildPkbReminderWithHints(inputs);
      parts.push(reminder);
    }

    if (hasContext) {
      const contextBlock = buildPkbContextBlock(inputs.pkbContext!);
      parts.push(contextBlock);
    }

    // Join reminder + context with a blank-line separator so the
    // combined block renders as two logical sections — matches the
    // pre-migration behaviour where they were two separate content
    // blocks separated by the tokenizer's default inter-block newline.
    return {
      id: "pkb",
      text: parts.join("\n\n"),
      placement: "after-memory-prefix",
    };
  },
};

/**
 * Render the PKB context block — wraps the raw content in
 * `<knowledge_base>...</knowledge_base>` while escaping any closing tags
 * inside the content that would break out of the XML wrapper. Mirrors the
 * body of the pre-migration `injectPkbContext` helper exactly so the emitted
 * bytes match.
 */
function buildPkbContextBlock(content: string): string {
  const escaped = content.replace(
    /<\/knowledge_base\s*>/gi,
    "&lt;/knowledge_base&gt;",
  );
  return `<knowledge_base>\n${escaped}\n</knowledge_base>`;
}

/**
 * Build the PKB `<system_reminder>` text. When a dense query vector plus
 * enough scope metadata is available, run the hybrid PKB search to
 * surface up to three relevance hints; fall back to the flat static
 * reminder on empty results or any error.
 *
 * Lifted verbatim from the pre-migration `applyRuntimeInjections` branch
 * so the emitted bytes match.
 */
async function buildPkbReminderWithHints(
  inputs: TurnInjectionInputs,
): Promise<string> {
  let hints: string[] = [];
  const queryVector = inputs.pkbQueryVector;
  if (
    queryVector &&
    queryVector.length > 0 &&
    inputs.pkbScopeId &&
    inputs.pkbConversation &&
    inputs.pkbRoot
  ) {
    try {
      const results = await searchPkbFiles(
        queryVector,
        inputs.pkbSparseVector,
        8,
        [inputs.pkbScopeId],
      );
      const workingDir = inputs.pkbWorkingDir ?? inputs.pkbRoot;
      const inContext = getInContextPkbPaths(
        inputs.pkbConversation,
        inputs.pkbAutoInjectList ?? [],
        inputs.pkbRoot,
        workingDir,
      );
      const pkbRoot = inputs.pkbRoot;
      // Gate on `denseScore` (cosine, [0, 1]) so the quality bar is stable
      // regardless of whether sparse was provided. Rank by `hybridScore`
      // (RRF) when available — that captures the sparse signal for
      // re-ordering eligible hits. hybridScore and denseScore live on
      // different scales, so items with hybridScore are ordered together
      // and placed ahead of items that only have denseScore.
      hints = results
        .filter((r) => {
          const abs = resolve(pkbRoot, r.path);
          if (inContext.has(abs)) return false;
          const threshold = r.path.replace(/\\/g, "/").startsWith("archive/")
            ? PKB_HINT_ARCHIVE_THRESHOLD
            : PKB_HINT_THRESHOLD;
          return r.denseScore >= threshold;
        })
        .sort((a, b) => {
          const aHasHybrid = a.hybridScore !== undefined;
          const bHasHybrid = b.hybridScore !== undefined;
          if (aHasHybrid && !bHasHybrid) return -1;
          if (!aHasHybrid && bHasHybrid) return 1;
          if (aHasHybrid && bHasHybrid) {
            return b.hybridScore! - a.hybridScore!;
          }
          return b.denseScore - a.denseScore;
        })
        .slice(0, 3)
        .map((r) => r.path);
    } catch (err) {
      pkbReminderLog.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "PKB hint search failed — falling back to flat reminder",
      );
      hints = [];
    }
  }
  return buildPkbReminder(hints);
}

/**
 * `now-md` injector — order 40, after-memory-prefix.
 *
 * Injects the NOW.md scratchpad content as
 * `<NOW.md Always keep this up to date; keep under 10 lines>...` after any
 * memory-prefix blocks.
 *
 * Gating:
 *  - `mode === "full"` (skipped in minimal mode).
 *  - `nowScratchpad` is a non-null, non-empty string.
 */
export const nowMdInjector: Injector = {
  name: "now-md",
  order: DEFAULT_INJECTOR_ORDER.nowMd,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    const content = inputs.nowScratchpad;
    if (!content) return null;
    const text = `<NOW.md Always keep this up to date; keep under 10 lines>\n${content}\n</NOW.md>`;
    return {
      id: "now-md",
      text,
      placement: "after-memory-prefix",
    };
  },
};

/**
 * `subagent-status` injector — order 50, append-user-tail.
 *
 * Appends a pre-built `<active_subagents>` block to the tail user message
 * so the parent LLM has visibility into active/completed child subagents.
 *
 * The orchestrator builds the block via `buildSubagentStatusBlock` before
 * the chain runs; this injector is a thin passthrough that applies gating
 * and positioning.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `subagentStatusBlock` is a non-null, non-empty string.
 */
export const subagentStatusInjector: Injector = {
  name: "subagent-status",
  order: DEFAULT_INJECTOR_ORDER.subagentStatus,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    const block = inputs.subagentStatusBlock;
    if (!block) return null;
    return {
      id: "subagent-status",
      text: block,
      placement: "append-user-tail",
    };
  },
};

/**
 * `slack-messages` injector — order 60, replace-run-messages.
 *
 * Swaps the conversation's `runMessages` array with a pre-rendered
 * chronological Slack transcript built from the persisted message rows.
 * Applied to every Slack conversation (channels and DMs alike). The
 * orchestrator builds the transcript via `loadSlackChronologicalMessages`
 * before the chain runs.
 *
 * The injector preserves the pre-migration memory-block prepending
 * behaviour: `extractMemoryPrefixBlocks` is re-applied to the Slack
 * transcript's tail user message inside `applyRuntimeInjections` when the
 * replacement fires.
 *
 * Active in both `full` and `minimal` mode — Slack transcript replacement
 * is not a high-token optional block, it's the canonical view of Slack
 * history for the model.
 *
 * Gating:
 *  - `channelCapabilities.channel === "slack"`.
 *  - `slackChronologicalMessages` has at least one entry.
 */
export const slackMessagesInjector: Injector = {
  name: "slack-messages",
  order: DEFAULT_INJECTOR_ORDER.slackMessages,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    if (inputs.channelCapabilities?.channel !== "slack") return null;
    const messages = inputs.slackChronologicalMessages;
    if (!messages || messages.length === 0) return null;
    return {
      id: "slack-messages",
      // `text` is informational only — `replace-run-messages` placements
      // bypass the tail-user-message splice path. Kept non-empty so
      // `composeInjectorChain` (text-only consumers) still counts this
      // injector as contributing content.
      text: "[slack-chronological-transcript]",
      placement: "replace-run-messages",
      messagesOverride: messages,
    };
  },
};

/**
 * `thread-focus` injector — order 70, append-user-tail.
 *
 * Appends a non-persisted `<active_thread>` block listing the parent +
 * replies of the thread the current inbound user message belongs to, so
 * the model can orient even when the channel-wide chronological transcript
 * is long and interleaved.
 *
 * The orchestrator builds the block via `loadSlackActiveThreadFocusBlock`
 * (which short-circuits for DMs). This injector wraps the value so the
 * block is applied declaratively through the chain.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `channelCapabilities.channel === "slack"` and `chatType === "channel"`
 *    (non-DM Slack conversation).
 *  - `slackActiveThreadFocusBlock` is a non-empty string.
 */
export const threadFocusInjector: Injector = {
  name: "thread-focus",
  order: DEFAULT_INJECTOR_ORDER.threadFocus,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    const caps = inputs.channelCapabilities;
    if (!caps || caps.channel !== "slack" || caps.chatType !== "channel") {
      return null;
    }
    const block = inputs.slackActiveThreadFocusBlock;
    if (typeof block !== "string" || block.length === 0) return null;
    return {
      id: "thread-focus",
      text: block,
      placement: "append-user-tail",
    };
  },
};

/**
 * Bundle every default injector into a single first-party plugin. Registered
 * at daemon startup via `external-plugins-bootstrap.ts`.
 *
 * Using one plugin per injector would inflate the registry and create
 * spurious registration-order dependencies; a single plugin keeps the
 * ordering contract entirely in the `order` field.
 */
export const defaultInjectorsPlugin: Plugin = {
  manifest: {
    name: "default-injectors",
    version: "1.0.0",
    requires: {
      pluginRuntime: "v1",
    },
  },
  injectors: [
    workspaceContextInjector,
    unifiedTurnContextInjector,
    pkbInjector,
    nowMdInjector,
    subagentStatusInjector,
    slackMessagesInjector,
    threadFocusInjector,
  ],
};
