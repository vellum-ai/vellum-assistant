/**
 * Default runtime injector plugin — the canonical chain of injectors that
 * drives the per-turn injection sequence consumed by
 * `applyRuntimeInjections`.
 *
 * Each of the eight default injectors reads its per-turn inputs from
 * `ctx.injectionInputs` (see {@link TurnInjectionInputs}), runs its gating
 * conditions (injection mode, feature flags, channel type, null-input
 * short-circuits), and returns an {@link InjectionBlock} with a
 * {@link InjectionPlacement} that yields the canonical positional
 * semantics expected by the assembly pipeline:
 *
 * | name                     | order | placement               |
 * | ------------------------ | ----- | ----------------------- |
 * | `workspace-context`      | 10    | prepend-user-tail       |
 * | `unified-turn-context`   | 20    | prepend-user-tail       |
 * | `pkb-context`            | 30    | after-memory-prefix     |
 * | `pkb-reminder`           | 35    | after-memory-prefix     |
 * | `memory-v2-static`       | 38    | after-memory-prefix     |
 * | `now-md`                 | 40    | after-memory-prefix     |
 * | `subagent-status`        | 50    | append-user-tail        |
 * | `slack-messages`         | 60    | replace-run-messages    |
 * | `thread-focus`           | 70    | append-user-tail        |
 *
 * `order` matches the intended final-content ordering: lower `order` ends
 * up closer to the top of the user message's content (for prepends), and
 * within `after-memory-prefix` each successive splice lands at the memory
 * boundary — so higher-`order` blocks push earlier splices away and end up
 * closer to the memory prefix themselves. For appends, ascending `order` is
 * the natural left-to-right append sequence. The runtime-injection applier
 * sorts and applies blocks declaratively so this invariant holds even when
 * third-party injectors slot additional blocks at fractional order values.
 *
 * Third-party plugins may register additional {@link Injector}s at any
 * `order` value; the registry's `getInjectors()` returns all injectors
 * sorted ascending, so a plugin-registered injector at `order: 25`
 * reliably slots between `unified-turn-context` (20) and `pkb` (30).
 *
 * Registration happens via a module-load side effect at the bottom of this
 * file — importing the module is enough to populate the registry. The
 * explicit `registerDefaultPlugins()` call in `plugins/defaults/index.ts`
 * (invoked from `daemon/external-plugins-bootstrap.ts`) re-registers the
 * same plugin idempotently, so either entry point alone is sufficient.
 */

import { resolve } from "node:path";

import { getConfig } from "../../config/loader.js";
import { getInContextPkbPaths } from "../../daemon/pkb-context-tracker.js";
import { buildPkbReminder } from "../../daemon/pkb-reminder-builder.js";
import { isMemoryV2ReadActive } from "../../memory/context-search/sources/memory-v2.js";
import { searchPkbFiles } from "../../memory/pkb/pkb-search.js";
import { getLogger } from "../../util/logger.js";
import { registerPlugin } from "../registry.js";
import {
  type InjectionBlock,
  type Injector,
  type Plugin,
  PluginExecutionError,
  type TurnContext,
  type TurnInjectionInputs,
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
 * Fixed order values for the eight default injectors. Exported so tests —
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
  pkbContext: 30,
  pkbReminder: 35,
  memoryV2Static: 38,
  nowMd: 40,
  subagentStatus: 50,
  slackMessages: 60,
  threadFocus: 70,
} as const satisfies Record<string, number>;

function readInjectionInputs(ctx: TurnContext): TurnInjectionInputs {
  return ctx.injectionInputs ?? {};
}

/**
 * v2 read-side cutover guard. The `pkb-context` injector silences itself
 * under v2 because the `<knowledge_base>` block surfaces PKB content the v2
 * activation block already covers. The `pkb-reminder` injector still fires
 * (its body is generic recall/remember guidance) but skips the hybrid-search
 * hints — those name PKB paths v2 is moving away from. NOW.md is workspace
 * state independent of PKB and fires unchanged.
 */
function isPkbInjectionSilencedByV2(): boolean {
  return isMemoryV2ReadActive(getConfig());
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
const workspaceContextInjector: Injector = {
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
const unifiedTurnContextInjector: Injector = {
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
 * `pkb-context` injector — order 30, after-memory-prefix.
 *
 * Emits the `<knowledge_base>` block (auto-injected PKB content) as its own
 * after-memory-prefix splice. Lower `order` than `pkb-reminder` so when both
 * fire, the reminder splices second and lands closer to the memory prefix,
 * yielding `[...memory, <system_reminder>, <knowledge_base>, ...user text]`.
 *
 * Emitting context and reminder as two separate blocks (rather than a single
 * concatenated text) produces the two-ContentBlock shape that the rehydration
 * path in `conversation-lifecycle.ts` recreates — keeping fresh-injection and
 * rehydrated-history structurally identical so Anthropic's prefix cache
 * matches across reloads.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - Non-null, non-empty `pkbContext`.
 */
const pkbContextInjector: Injector = {
  name: "pkb-context",
  order: DEFAULT_INJECTOR_ORDER.pkbContext,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    if (isPkbInjectionSilencedByV2()) return null;
    if (!inputs.pkbContext) return null;
    return {
      id: "pkb-context",
      text: buildPkbContextBlock(inputs.pkbContext),
      placement: "after-memory-prefix",
    };
  },
};

/**
 * `pkb-reminder` injector — order 35, after-memory-prefix.
 *
 * Emits the PKB `<system_reminder>` (behavioural nudge + hybrid-search
 * hints) as its own after-memory-prefix splice. Higher `order` than
 * `pkb-context` so the reminder splices second and ends up immediately
 * after the memory prefix, pushing `<knowledge_base>` one slot further
 * down — producing a [reminder, context] ordering.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `pkbActive === true`.
 */
const pkbReminderInjector: Injector = {
  name: "pkb-reminder",
  order: DEFAULT_INJECTOR_ORDER.pkbReminder,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    if (!inputs.pkbActive) return null;
    const reminder = isPkbInjectionSilencedByV2()
      ? buildPkbReminder([])
      : await buildPkbReminderWithHints(inputs);
    return {
      id: "pkb-reminder",
      text: reminder,
      placement: "after-memory-prefix",
    };
  },
};

/**
 * Render the PKB context block — wraps the raw content in
 * `<knowledge_base>...</knowledge_base>` while escaping any closing tags
 * inside the content that would break out of the XML wrapper.
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
 * `memory-v2-static` injector — order 38, after-memory-prefix.
 *
 * Injects the v2 static memory block (essentials/threads/recent/buffer
 * concatenated under markdown headings) wrapped in `<memory>...</memory>`
 * onto the user message. The agent loop only forwards `memoryV2Static` on
 * full-mode turns (first turn / post-compaction), mirroring the PKB
 * auto-inject cadence — subsequent turns get `null` and the prior block
 * stays cached on its original user message.
 *
 * Sits between `pkb-reminder` (35) and `now-md` (40) so the rendered order
 * after the memory prefix is `[pkb-reminder, pkb-context, memory-v2-static,
 * now-md, ...user text]` when every PKB injector also fires (transitional
 * state). Once PKB is fully retired under v2 this is the only block
 * adjacent to the memory prefix.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `memoryV2Static` is a non-null, non-empty string.
 */
const memoryV2StaticInjector: Injector = {
  name: "memory-v2-static",
  order: DEFAULT_INJECTOR_ORDER.memoryV2Static,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const inputs = readInjectionInputs(ctx);
    const mode = inputs.mode ?? "full";
    if (mode !== "full") return null;
    const content = inputs.memoryV2Static;
    if (!content) return null;
    return {
      id: "memory-v2-static",
      text: buildMemoryV2StaticBlock(content),
      placement: "after-memory-prefix",
    };
  },
};

/**
 * Wrap the static memory content in `<memory>...</memory>`. Escapes any
 * closing `</memory>` inside the content so authored memory files cannot
 * accidentally break out of the wrapper.
 */
function buildMemoryV2StaticBlock(content: string): string {
  const escaped = content.replace(/<\/memory\s*>/gi, "&lt;/memory&gt;");
  return `<memory>\n${escaped}\n</memory>`;
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
const nowMdInjector: Injector = {
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
const subagentStatusInjector: Injector = {
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
 * Memory-block prepending is preserved across the replacement:
 * `extractMemoryPrefixBlocks` is re-applied to the Slack transcript's tail
 * user message inside `applyRuntimeInjections` when the replacement fires.
 *
 * Active in both `full` and `minimal` mode — Slack transcript replacement
 * is not a high-token optional block, it's the canonical view of Slack
 * history for the model.
 *
 * Gating:
 *  - `channelCapabilities.channel === "slack"`.
 *  - `slackChronologicalMessages` has at least one entry.
 */
const slackMessagesInjector: Injector = {
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
const threadFocusInjector: Injector = {
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
    pkbContextInjector,
    pkbReminderInjector,
    memoryV2StaticInjector,
    nowMdInjector,
    subagentStatusInjector,
    slackMessagesInjector,
    threadFocusInjector,
  ],
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultInjectorsPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultInjectorsPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}
