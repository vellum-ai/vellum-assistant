/**
 * Default runtime injector plugin — the canonical chain of injectors that
 * drives the per-turn injection sequence consumed by
 * `applyRuntimeInjections`.
 *
 * Each default injector reads its per-turn inputs directly off the
 * {@link TurnContext}, runs its gating
 * conditions (injection mode, feature flags, channel type, null-input
 * short-circuits), and returns an {@link InjectionBlock} with a
 * {@link InjectionPlacement} that yields the canonical positional
 * semantics expected by the assembly pipeline:
 *
 * | name                     | order | placement               |
 * | ------------------------ | ----- | ----------------------- |
 * | `disk-pressure-warning`  | 5     | prepend-user-tail       |
 * | `workspace-context`      | 10    | prepend-user-tail       |
 * | `unified-turn-context`   | 20    | prepend-user-tail       |
 * | `config-quarantine-notice` | 25  | prepend-user-tail       |
 * | `pkb-context`            | 30    | after-memory-prefix     |
 * | `pkb-reminder`           | 35    | after-memory-prefix     |
 * | `memory-v2-static`       | 38    | after-memory-prefix     |
 * | `now-md`                 | 40    | after-memory-prefix     |
 * | `active-documents`       | 45    | prepend-user-tail       |
 * | `document-comments`      | 46    | prepend-user-tail       |
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
 * injectors slot additional blocks at fractional order values.
 *
 * This module exports the default injectors as a plain ordered array
 * ({@link defaultInjectors}). The chain assembler in
 * `plugins/defaults/memory-retrieval/injector-chain.ts` sorts them by `order`
 * (alongside the memory-v3 injector) into the single sequence
 * `applyRuntimeInjections` walks each turn — injection is not a plugin
 * contribution, so injectors are imported directly rather than aggregated
 * through the registry.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { getConfig } from "../../../config/loader.js";
import type { InjectionMatcher } from "../../../context/strip-injections.js";
import { findConversationOrSubagent } from "../../../daemon/conversation-registry.js";
import { resolveWorkspaceTopLevelContext } from "../../../daemon/conversation-workspace.js";
import { readNowScratchpad } from "../../../daemon/now-scratchpad.js";
import { getInContextPkbPaths } from "../../../daemon/pkb-context-tracker.js";
import { buildPkbReminder } from "../../../daemon/pkb-reminder-builder.js";
import {
  isPersonalMemoryAllowed,
  type TrustContext,
} from "../../../daemon/trust-context.js";
import { listComments } from "../../../documents/document-comments-store.js";
import { getLiveGraphMemory } from "../../../memory/graph/conversation-graph-memory.js";
import { getPkbAutoInjectList } from "../../../memory/pkb/autoinject.js";
import { readPkbContext } from "../../../memory/pkb/context.js";
import { searchPkbFiles } from "../../../memory/pkb/pkb-search.js";
import { getPkbRoot, PKB_WORKSPACE_SCOPE } from "../../../memory/pkb/types.js";
import { readMemoryV2StaticContent } from "../../../memory/v2/static-context.js";
import type { Message } from "../../../providers/types.js";
import { getLogger } from "../../../util/logger.js";
import {
  getConfigQuarantineNoticePath,
  getSandboxWorkingDir,
} from "../../../util/platform.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { buildUnifiedTurnContextBlock } from "./unified-turn-context.js";

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
 * Fixed order values for the default injectors. Exported so tests —
 * and any future integration code — can assert ordering without re-deriving
 * the constants.
 *
 * Gaps of 10 between slots leave room for future injectors to slot in
 * at granular positions (e.g. `25` between unified-turn-context and pkb)
 * without renumbering the defaults.
 */
export const DEFAULT_INJECTOR_ORDER = {
  diskPressureWarning: 5,
  workspaceContext: 10,
  backgroundTurn: 15,
  unifiedTurnContext: 20,
  configQuarantineNotice: 25,
  pkbContext: 30,
  pkbReminder: 35,
  memoryV2Static: 38,
  nowMd: 40,
  activeDocuments: 45,
  documentComments: 46,
  subagentStatus: 50,
  slackMessages: 60,
  threadFocus: 70,
} as const satisfies Record<string, number>;

export const DISK_PRESSURE_WARNING_PROMPT = `<disk_pressure_warning>
Disk usage is critically low: this assistant is in storage cleanup mode because the workspace volume is critically full.

In your first paragraph, warn the user that storage is critically low and that normal work is suspended until space is freed.

Then help the user clean up storage. Prefer safe inspection steps first, such as checking available space and finding large directories. Ask before deleting files or caches unless the user has already clearly approved the specific cleanup action.

Do not work on unrelated tasks until enough space is freed to clear the lock or the user explicitly overrides it. Background processes and messages from trusted contacts are blocked while this cleanup mode is active.
</disk_pressure_warning>`;

/**
 * `disk-pressure-warning` injector — order 5, prepend-user-tail.
 *
 * Emits the storage cleanup-mode warning at the very top of the user tail when
 * the turn is restricted to disk-pressure cleanup. Reads the cleanup-mode flag
 * off the live `Conversation` looked up by conversation id — the agent loop
 * sets `diskPressureCleanupModeActive` when it classifies the turn's
 * disk-pressure policy — rather than having the loop thread it as an injection
 * input.
 */
const diskPressureWarningInjector: Injector = {
  name: "disk-pressure-warning",
  order: DEFAULT_INJECTOR_ORDER.diskPressureWarning,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const conversation = findConversationOrSubagent(ctx.conversationId);
    if (!conversation?.diskPressureCleanupModeActive) return null;
    return {
      id: "disk-pressure-warning",
      text: DISK_PRESSURE_WARNING_PROMPT,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * v2 read-side cutover guard. Under v2 both `pkb-context` and `pkb-reminder`
 * silence themselves entirely — the `<knowledge_base>` content and the
 * generic recall/remember nudge are both supplanted by the v2 static
 * `<memory>` block. NOW.md is workspace state independent of PKB and fires
 * unchanged.
 */
function isPkbInjectionSilencedByV2(): boolean {
  return getConfig().memory.v2.enabled;
}

/**
 * Matchers that mark a persisted `<workspace>` top-level injection. Uses the
 * `{ prefix, suffix }` wrapper shape so user-authored text merely starting with
 * `<workspace>\n` is never mistaken for an injection — matching the full-wrapper
 * requirement the compaction strip uses for this block. The legacy
 * `<workspace_top_level>` tag (pre-rename history) counts as present too.
 */
const WORKSPACE_BLOCK_MATCHERS: readonly InjectionMatcher[] = [
  { prefix: "<workspace>\n", suffix: "\n</workspace>" },
  "<workspace_top_level>",
];

/**
 * `workspace-context` injector — order 10, prepend-user-tail.
 *
 * Injects the workspace top-level directory context at the very top of the
 * user tail's content so the assistant sees a workspace grounding block before
 * any other per-turn context.
 *
 * Sources the dirty-guarded top-level cache itself via
 * {@link resolveWorkspaceTopLevelContext} (keyed by conversation id) rather than
 * having the agent loop compute and thread it. Decides inject/skip by presence
 * detection: the block is (re)injected only when it is absent from the working
 * messages — true on the first turn and right after compaction strips it — and
 * skipped on normal cached turns where it already persists in history. This
 * keeps the conversation prefix stable for Anthropic's prefix caching.
 *
 * Gating:
 *  - `mode === "full"` (skipped in minimal mode).
 *  - the rendered workspace context is a non-null, non-empty string.
 *  - no `<workspace>` block is already present in `runMessages`.
 */
const workspaceContextInjector: Injector = {
  name: "workspace-context",
  order: DEFAULT_INJECTOR_ORDER.workspaceContext,
  async produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const text = resolveWorkspaceTopLevelContext(ctx.conversationId);
    if (!text) return null;
    if (hasInjectedUserTextBlock(runMessages, WORKSPACE_BLOCK_MATCHERS))
      return null;
    return {
      id: "workspace-context",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `background-turn` injector — order 15, prepend-user-tail.
 *
 * Wraps the tail user message with a `<background_turn>` block that tells
 * the assistant the guardian isn't watching and that anything noteworthy
 * should be surfaced via the `notifications` skill. Fires only when (a) the
 * conversation's type is "background" or "scheduled" (see
 * `isBackgroundConversationType`) AND (b) no client is currently connected
 * (`isNonInteractive`). The second gate is what prevents the reminder from
 * firing on a manual follow-up the guardian sends into a background thread
 * — at that point the guardian IS watching, so the framing doesn't apply.
 *
 * The inner text is read from `config.conversations.backgroundInjection`, so
 * operators can edit the reminder without a code change. Setting it to the
 * empty string disables the injection entirely.
 */
const backgroundTurnInjector: Injector = {
  name: "background-turn",
  order: DEFAULT_INJECTOR_ORDER.backgroundTurn,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (!ctx.isBackgroundConversation) return null;
    if (!ctx.isNonInteractive) return null;
    const inner = getConfig().conversations.backgroundInjection;
    if (!inner) return null;
    return {
      id: "background-turn",
      text: `<background_turn>\n${inner}\n</background_turn>`,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `unified-turn-context` injector — order 20, prepend-user-tail.
 *
 * Injects the `<turn_context>` block that combines temporal, actor, channel,
 * and interface context. The orchestrator resolves the block's inputs onto the
 * per-turn {@link TurnContext}; this injector builds the text from them
 * via `buildUnifiedTurnContextBlock`. Emits nothing when no `timestamp` is
 * present (the inputs were not resolved for this turn).
 *
 * Active in both `full` and `minimal` mode — unified turn context is
 * safety-critical grounding that must survive injection downgrade.
 */
const unifiedTurnContextInjector: Injector = {
  name: "unified-turn-context",
  order: DEFAULT_INJECTOR_ORDER.unifiedTurnContext,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const { timestamp } = ctx;
    if (!timestamp) return null;
    const text = buildUnifiedTurnContextBlock({
      timestamp,
      interfaceName: ctx.interfaceName,
      channelName: ctx.channelName,
      actorContext: ctx.actorContext,
      configuredUserTimezone: ctx.configuredUserTimezone,
      clientTimezone: ctx.clientTimezone,
      detectedTimezone: ctx.detectedTimezone,
      timeSinceLastMessage: ctx.timeSinceLastMessage,
      modelProfile: ctx.modelProfile,
    });
    return {
      id: "unified-turn-context",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * Maximum age of a config-quarantine notice before it is considered stale.
 * After this window the sentinel is deleted and nothing is injected — the
 * event is no longer actionable context for the agent.
 */
const CONFIG_QUARANTINE_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Shape of the config-quarantine notice sentinel written by the config loader. */
interface ConfigQuarantineNotice {
  quarantinedAt: string;
  quarantinePath: string;
  originalPath: string;
}

/**
 * Read and validate the config-quarantine notice sentinel. Returns the parsed
 * notice when the file exists and carries the expected string fields, otherwise
 * `null`. Best-effort: any read/parse error is swallowed and treated as absent.
 */
function readConfigQuarantineNotice(): ConfigQuarantineNotice | null {
  const noticePath = getConfigQuarantineNoticePath();
  if (!existsSync(noticePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(noticePath, "utf-8"));
    if (parsed == null || typeof parsed !== "object") return null;
    const { quarantinedAt, quarantinePath, originalPath } = parsed as Record<
      string,
      unknown
    >;
    if (
      typeof quarantinedAt !== "string" ||
      typeof quarantinePath !== "string" ||
      typeof originalPath !== "string"
    ) {
      return null;
    }
    return { quarantinedAt, quarantinePath, originalPath };
  } catch {
    return null;
  }
}

/**
 * `config-quarantine-notice` injector — order 25, prepend-user-tail.
 *
 * Surfaces a recent config-quarantine event to the agent. The config loader
 * writes a JSON sentinel ({@link getConfigQuarantineNoticePath}) when it
 * quarantines a corrupt `config.json` and falls back to defaults. This injector
 * reads that sentinel and, when it is younger than
 * {@link CONFIG_QUARANTINE_NOTICE_MAX_AGE_MS}, injects a short block telling the
 * agent the user's settings were reset and where the original is preserved, so
 * it can explain the change if the user asks about missing settings/API keys —
 * or mention it proactively when relevant. A stale sentinel is deleted and
 * nothing is injected.
 *
 * Active in both `full` and `minimal` mode — a settings reset is grounding the
 * agent should not lose to injection downgrade. The block is non-persisted
 * (re-evaluated every turn) so the notice naturally stops appearing once the
 * sentinel ages out or is removed.
 *
 * Guardian-only: turns driven by non-guardian actors (trusted contacts,
 * unknown channel senders) must not see workspace file paths or be told the
 * guardian's settings were reset — the notice is only actionable in guardian
 * conversations.
 */
const configQuarantineNoticeInjector: Injector = {
  name: "config-quarantine-notice",
  order: DEFAULT_INJECTOR_ORDER.configQuarantineNotice,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (ctx.trust.trustClass !== "guardian") return null;

    const notice = readConfigQuarantineNotice();
    if (!notice) return null;

    const quarantinedAtMs = Date.parse(notice.quarantinedAt);
    const ageMs = Number.isNaN(quarantinedAtMs)
      ? Number.POSITIVE_INFINITY
      : Date.now() - quarantinedAtMs;
    if (ageMs > CONFIG_QUARANTINE_NOTICE_MAX_AGE_MS) {
      try {
        rmSync(getConfigQuarantineNoticePath(), { force: true });
      } catch {
        // Best-effort cleanup — a failed delete just means we re-check (and
        // re-attempt deletion) next turn.
      }
      return null;
    }

    const text =
      `<config_reset_notice>\n` +
      `The user's config.json was unreadable and was reset to defaults at ` +
      `${notice.quarantinedAt}. The original file was preserved at ` +
      `${notice.quarantinePath}. Any custom settings the user had (API keys, ` +
      `model choices, voice preferences) are still in that file but are not ` +
      `currently active.\n\n` +
      `If the user asks why a setting, API key, or preference is missing or ` +
      `changed, explain this reset and point them at the preserved file to ` +
      `recover their settings. Otherwise mention it proactively only when it ` +
      `is clearly relevant — do not interrupt unrelated work.\n` +
      `</config_reset_notice>`;
    return {
      id: "config-quarantine-notice",
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
 *  - The personal-memory trust gate admits the actor and the workspace has
 *    PKB content (see {@link readGatedPkbContext}).
 *  - The `<knowledge_base>` block is not already present in the turn's working
 *    messages. The big block is injected once and then persists in history, so
 *    it only needs (re)injecting on the first turn and right after compaction
 *    strips it — both of which leave the working messages without the block.
 *    Skipping when it is present keeps the conversation prefix stable for
 *    Anthropic's prefix caching and avoids a duplicate splice.
 */
const pkbContextInjector: Injector = {
  name: "pkb-context",
  order: DEFAULT_INJECTOR_ORDER.pkbContext,
  async produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    if (isPkbInjectionSilencedByV2()) return null;
    const content = readGatedPkbContext(ctx.trust);
    if (!content) return null;
    if (hasInjectedUserTextBlock(runMessages, KNOWLEDGE_BASE_BLOCK_PREFIXES))
      return null;
    return {
      id: "pkb-context",
      text: buildPkbContextBlock(content),
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
 *  - PKB is active for the turn (see {@link isPkbActive}).
 */
const pkbReminderInjector: Injector = {
  name: "pkb-reminder",
  order: DEFAULT_INJECTOR_ORDER.pkbReminder,
  async produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    if (!isPkbActive(ctx.trust)) return null;
    if (isPkbInjectionSilencedByV2()) return null;
    const reminder = await buildPkbReminderWithHints(ctx, runMessages);
    return {
      id: "pkb-reminder",
      text: reminder,
      placement: "after-memory-prefix",
    };
  },
};

/**
 * Read the auto-injected PKB content for the turn, gated behind the
 * personal-memory trust gate. Returns the content string when the gate admits
 * the actor and the workspace has PKB content, otherwise `null`. Both the gate
 * and the content are sourced from the turn's trust context and the PKB files
 * directly, so the memory-domain injectors source their own inputs rather than
 * having them threaded in from the agent loop.
 */
function readGatedPkbContext(trust: TrustContext): string | null {
  return isPersonalMemoryAllowed(trust) ? readPkbContext() : null;
}

/**
 * Read the NOW.md scratchpad content for the turn, gated behind the
 * personal-memory trust gate and the `scratchpadInjection` config toggle.
 * Returns the trimmed content when both gates admit and the file is non-empty,
 * otherwise `null`. Sourced from the trust context and the NOW.md file directly
 * so the `now-md` injector owns its input rather than having it threaded in.
 */
function readGatedNowScratchpad(trust: TrustContext): string | null {
  if (!isPersonalMemoryAllowed(trust)) return null;
  if (!getConfig().memory.retrieval.scratchpadInjection.enabled) return null;
  return readNowScratchpad();
}

/**
 * Read the v2 static memory content for the turn, gated behind the
 * personal-memory trust gate. Returns the content (essentials/threads/recent/
 * buffer concatenated) when the gate admits and v2 memory is enabled,
 * otherwise `null`. {@link readMemoryV2StaticContent} self-gates on the v2
 * flag + config, so the `memory-v2-static` injector owns its input rather than
 * having it threaded in from the agent loop.
 *
 * `excludeBuffer` is forwarded for consolidation turns, whose contract is the
 * buffer FILE itself — see {@link readMemoryV2StaticContent}.
 */
function readGatedMemoryV2Static(
  trust: TrustContext,
  options: { excludeBuffer?: boolean } = {},
): string | null {
  return isPersonalMemoryAllowed(trust)
    ? readMemoryV2StaticContent(options)
    : null;
}

/**
 * Whether PKB is active for the turn: the personal-memory trust gate admits
 * the actor and the workspace has PKB content to surface.
 */
function isPkbActive(trust: TrustContext): boolean {
  return readGatedPkbContext(trust) !== null;
}

/** Block prefixes that mark a persisted `<knowledge_base>` injection. */
const KNOWLEDGE_BASE_BLOCK_PREFIXES = [
  "<knowledge_base>",
  "<pkb>", // backward-compat: pre-rename history
] as const;

/** Block prefixes that mark a persisted NOW.md injection. */
const NOW_MD_BLOCK_PREFIXES = [
  "<NOW.md Always keep this up to date",
  "<now_scratchpad>", // backward-compat: pre-rename history
] as const;

/**
 * Matchers that mark a persisted `memory-v2-static` injection. Uses the
 * `{ prefix, suffix }` wrapper shape (not a bare prefix) so user-authored text
 * merely starting with `<info>\n` is never mistaken for an injection — matching
 * the full-wrapper requirement the compaction strip uses for this block.
 *
 * Match ONLY the `<info>…</info>` wrapper — the form the static block is always
 * written as today (see {@link buildMemoryV2StaticBlock}). The matcher must NOT
 * also match `<memory>…</memory>`: the v2 *dynamic* activation block uses that
 * same wrapper and `prepareMemory` prepends it to the tail user message every
 * turn, before this injector chain runs. Counting `<memory>` as "static block
 * already present" made the static injector skip on essentially every turn —
 * including the first turn and right after compaction, where the dynamic block
 * is re-added ahead of the chain — which dropped the `<info>` block entirely.
 *
 * Tradeoff: a conversation whose static block was persisted under the legacy
 * `<memory>` wrapper (pre-`<info>` switch) is no longer recognized here, so its
 * first post-fix turn may briefly carry both the stale `<memory>` view and a
 * fresh `<info>` block. That is rare (ancient histories only), cosmetic, and
 * self-heals on the next compaction (which strips both wrappers).
 */
const MEMORY_V2_STATIC_BLOCK_MATCHERS: readonly InjectionMatcher[] = [
  { prefix: "<info>\n", suffix: "\n</info>" },
];

/**
 * Whether a block matching any of the given matchers is already present in the
 * turn's working messages — used to skip re-injection of a block the history
 * already carries.
 *
 * Recognizes both the canonical standalone form (a text block that IS the
 * wrapper) and the "flattened" form where the wrapper sits as a newline-
 * delimited section inside a larger text block (see {@link textCarriesInjection}).
 *
 * Detection is intentionally BROADER than `stripUserTextBlocksByPrefix`, which
 * stays whole-block-only: re-injection must be suppressed even when a historical
 * user message's separate injection blocks have been collapsed into one text
 * block, whereas the strip must never delete a block that also holds the user's
 * own text. (A flattened block is summarized away at the next compaction, where
 * fresh injection resumes.)
 */
function hasInjectedUserTextBlock(
  runMessages: Message[] | undefined,
  matchers: readonly InjectionMatcher[],
): boolean {
  if (!runMessages) return false;
  return runMessages.some(
    (message) =>
      message.role === "user" &&
      message.content.some(
        (block) =>
          block.type === "text" &&
          matchers.some((m) => textCarriesInjection(block.text, m)),
      ),
  );
}

/**
 * Whether `text` carries an injected block matching `matcher`, recognizing both
 * the canonical standalone form (the text IS the wrapper) and a "flattened"
 * form where the wrapper sits as a newline-delimited section inside a larger
 * text block.
 *
 * The flattened form arises when a historical user message's separate injection
 * content blocks get collapsed into a single text block joined with "\n" —
 * observed when a daemon restart / plugin hot-reload rebuilt the rendered
 * history mid-conversation. Without recognizing it, the standalone-only check
 * returns false for the carried block and the injector re-injects a duplicate
 * `<workspace>` / `<info>` onto the new tail.
 *
 * Anchoring on line boundaries ("\n" before the opening tag, and "\n" or the
 * block edge after the closing tag) keeps the false-positive surface as narrow
 * as the standalone check: ordinary prose would have to contain the exact
 * wrapper as its own line-delimited section to be mistaken for an injection. The
 * `{ prefix, suffix }` form still requires BOTH tags, so a message that opens
 * (but never closes) an injection-like tag never suppresses injection.
 */
function textCarriesInjection(
  text: string,
  matcher: InjectionMatcher,
): boolean {
  if (typeof matcher === "string") {
    return text.startsWith(matcher) || text.includes(`\n${matcher}`);
  }
  const { prefix, suffix } = matcher;
  const hasOpen = text.startsWith(prefix) || text.includes(`\n${prefix}`);
  const hasClose = text.endsWith(suffix) || text.includes(`${suffix}\n`);
  return hasOpen && hasClose;
}

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
 * Build the PKB `<system_reminder>` text. When a dense query vector and the
 * turn's working messages are available, run the hybrid PKB search to
 * surface up to three relevance hints; fall back to the flat static
 * reminder on empty results or any error.
 *
 * The dense/sparse query pair is read off the conversation's live graph
 * handle ({@link getLiveGraphMemory}) — the memory-retrieval hook records it
 * there during the turn's retrieval. In-context PKB paths are computed from
 * the turn's working messages (`runMessages`, supplied by the injector chain)
 * resolved against the workspace working directory, so the reminder sources
 * its inputs itself rather than having them threaded through the agent loop.
 */
async function buildPkbReminderWithHints(
  ctx: TurnContext,
  runMessages?: Message[],
): Promise<string> {
  let hints: string[] = [];
  const graphMemory = getLiveGraphMemory(ctx.conversationId);
  const queryVector = graphMemory?.pkbQueryVector;
  if (queryVector && queryVector.length > 0 && runMessages) {
    try {
      const pkbRoot = getPkbRoot();
      const results = await searchPkbFiles(
        queryVector,
        graphMemory?.pkbSparseVector,
        8,
        [PKB_WORKSPACE_SCOPE],
      );
      const inContext = getInContextPkbPaths(
        { messages: runMessages },
        getPkbAutoInjectList(pkbRoot),
        pkbRoot,
        getSandboxWorkingDir(),
      );
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
 * concatenated under markdown headings) wrapped in `<info>...</info>`
 * onto the user message. The agent loop only forwards `memoryV2Static` on
 * full-mode turns (first turn / post-compaction), mirroring the PKB
 * auto-inject cadence — subsequent turns get `null` and the prior block
 * stays cached on its original user message.
 *
 * Sits between `pkb-reminder` (35) and `now-md` (40). Because every
 * after-memory-prefix splice lands at the memory-prefix boundary in
 * ascending `order`, higher-order blocks end up closer to the memory
 * prefix. The rendered layout is therefore `[<memory>dynamic</memory>,
 * <info>memory-v2-static</info>, <NOW.md>, <system_reminder>,
 * <knowledge_base>, ...user text]` when every PKB injector also fires.
 * `countMemoryPrefixBlocks` treats the `<info>` static block as part of
 * the memory prefix so `now-md` (40) splices after it.
 *
 * Gating:
 *  - `mode === "full"` (skipped in minimal mode).
 *  - The personal-memory trust gate admits the actor and v2 static memory has
 *    content (see {@link readGatedMemoryV2Static}).
 *  - The `<info>` block is not already present in the turn's working messages.
 *    Like `<knowledge_base>`, the block is injected once and then persists in
 *    history, so it only needs (re)injecting on the first turn and right after
 *    compaction strips it — both of which leave the working messages without
 *    the block. Skipping when it is present keeps the conversation prefix
 *    stable for Anthropic's prefix caching and avoids a duplicate splice.
 */
const memoryV2StaticInjector: Injector = {
  name: "memory-v2-static",
  order: DEFAULT_INJECTOR_ORDER.memoryV2Static,
  async produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    // The consolidation agent reads and rewrites memory/buffer.md through
    // file tools; injecting the buffer section here would duplicate the
    // entire backlog into its context (and go stale as it edits the file).
    const content = readGatedMemoryV2Static(ctx.trust, {
      excludeBuffer: ctx.callSite === "memoryV2Consolidation",
    });
    if (!content) return null;
    if (hasInjectedUserTextBlock(runMessages, MEMORY_V2_STATIC_BLOCK_MATCHERS))
      return null;
    return {
      id: "memory-v2-static",
      text: buildMemoryV2StaticBlock(content),
      placement: "after-memory-prefix",
    };
  },
};

const INFO_CLOSE_TAG_RE = /<\/info\s*>/gi;

/**
 * Wrap the static memory content in `<info>...</info>`. Escapes any
 * closing `</info>` inside the content so authored memory files cannot
 * accidentally break out of the wrapper. Distinct from the dynamic
 * activation block (which uses `<memory>...</memory>`) so downstream
 * logic can address the two differently.
 */
function buildMemoryV2StaticBlock(content: string): string {
  const escaped = content.replace(INFO_CLOSE_TAG_RE, "&lt;/info&gt;");
  return `<info>\n${escaped}\n</info>`;
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
 *  - The personal-memory trust gate admits the actor, the `scratchpadInjection`
 *    config toggle is on, and NOW.md has content (see
 *    {@link readGatedNowScratchpad}).
 *  - The NOW.md block is not already present in the turn's working messages.
 *    Like `<knowledge_base>`, the block is injected once and then persists in
 *    history, so it only needs (re)injecting on the first turn and right after
 *    compaction strips it — both of which leave the working messages without
 *    the block. Skipping when it is present keeps the conversation prefix
 *    stable for Anthropic's prefix caching and avoids a duplicate splice.
 */
const nowMdInjector: Injector = {
  name: "now-md",
  order: DEFAULT_INJECTOR_ORDER.nowMd,
  async produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const content = readGatedNowScratchpad(ctx.trust);
    if (!content) return null;
    if (hasInjectedUserTextBlock(runMessages, NOW_MD_BLOCK_PREFIXES))
      return null;
    const text = `<NOW.md Always keep this up to date; keep under 10 lines>\n${content}\n</NOW.md>`;
    return {
      id: "now-md",
      text,
      placement: "after-memory-prefix",
    };
  },
};

/**
 * `active-documents` injector — order 45, prepend-user-tail.
 *
 * Injects an `<active_documents>` block listing open documents in the
 * conversation so the assistant can target them with `document_update`
 * instead of creating duplicates via `document_create`.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `activeDocuments` has at least one entry.
 */
const activeDocumentsInjector: Injector = {
  name: "active-documents",
  order: DEFAULT_INJECTOR_ORDER.activeDocuments,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const docs = ctx.activeDocuments;
    if (!docs || docs.length === 0) return null;
    const lines = docs.map(
      (d) =>
        `- surface_id: "${d.surfaceId}", title: "${d.title}", words: ${d.wordCount}`,
    );
    const text = `<active_documents>\nThe following documents are open in this conversation. Use document_update with the surface_id to edit them — do NOT call document_create for documents that already exist.\n${lines.join("\n")}\n</active_documents>`;
    return {
      id: "active-documents",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/** Maximum open comments surfaced per document to limit context bloat. */
const DOCUMENT_COMMENTS_CAP = 10;

/**
 * Escape closing `</document_comments>` inside user-controlled strings so
 * they cannot break out of the XML wrapper — same pattern as
 * {@link buildPkbContextBlock} and {@link buildMemoryV2StaticBlock}.
 */
function escapeDocCommentTag(s: string): string {
  return s.replace(/<\/document_comments\s*>/gi, "&lt;/document_comments&gt;");
}

/**
 * `document-comments` injector — order 46, prepend-user-tail.
 *
 * Surfaces open top-level comments on active documents so the assistant
 * knows what feedback to address. For each active document, queries the
 * comment store for open top-level comments (capped at
 * {@link DOCUMENT_COMMENTS_CAP} most recent per document). Inline comments
 * include the quoted anchor text; doc-level comments are labelled as such.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `activeDocuments` has at least one entry.
 *  - At least one document has open comments (returns null otherwise).
 */
const documentCommentsInjector: Injector = {
  name: "document-comments",
  order: DEFAULT_INJECTOR_ORDER.documentComments,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const docs = ctx.activeDocuments;
    if (!docs || docs.length === 0) return null;

    const sections: string[] = [];
    for (const doc of docs) {
      const comments = listComments(doc.surfaceId, {
        status: "open",
        topLevelOnly: true,
      }).slice(-DOCUMENT_COMMENTS_CAP);
      if (comments.length === 0) continue;

      const lines = comments.map((c) => {
        const anchor =
          c.anchorText != null ? escapeDocCommentTag(c.anchorText) : null;
        const label =
          anchor != null ? `inline, anchored to "${anchor}"` : "doc-level";
        return `- Comment #${c.id} (${label}): "${escapeDocCommentTag(c.content)}"`;
      });
      sections.push(
        `Document: "${escapeDocCommentTag(doc.title)}" (surface_id: "${doc.surfaceId}")\n${lines.join("\n")}`,
      );
    }

    if (sections.length === 0) return null;

    const text = `<document_comments>
Open comments on your documents. Address these by editing the document, then use comment_resolve to mark each resolved.

${sections.join("\n\n")}
</document_comments>`;
    return {
      id: "document-comments",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `subagent-status` injector — order 50, append-user-tail.
 *
 * Appends a pre-built `<active_subagents>` block to the tail user message
 * so the parent LLM has visibility into active/completed child subagents.
 *
 * `applyRuntimeInjections` resolves the block from the live subagent manager
 * before the chain runs; this injector is a thin passthrough that applies
 * gating and positioning.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `subagentStatusBlock` is a non-null, non-empty string.
 */
const subagentStatusInjector: Injector = {
  name: "subagent-status",
  order: DEFAULT_INJECTOR_ORDER.subagentStatus,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const block = ctx.subagentStatusBlock;
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
 * orchestrator builds the transcript via `loadSlackChronologicalContext`
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
    if (ctx.channelCapabilities?.channel !== "slack") return null;
    const messages = ctx.slackChronologicalMessages;
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
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const caps = ctx.channelCapabilities;
    if (!caps || caps.channel !== "slack" || caps.chatType !== "channel") {
      return null;
    }
    const block = ctx.slackActiveThreadFocusBlock;
    if (typeof block !== "string" || block.length === 0) return null;
    return {
      id: "thread-focus",
      text: block,
      placement: "append-user-tail",
    };
  },
};

/**
 * Every default injector in ascending `order`. This is the canonical
 * first-party injection sequence consumed by `applyRuntimeInjections` via the
 * assembled injector chain.
 *
 * `order` is the source of truth for sequencing (see {@link DEFAULT_INJECTOR_ORDER});
 * the chain assembler sorts by it, so this array's literal order is only a
 * readability convenience.
 */
export const defaultInjectors: Injector[] = [
  diskPressureWarningInjector,
  workspaceContextInjector,
  backgroundTurnInjector,
  unifiedTurnContextInjector,
  configQuarantineNoticeInjector,
  pkbContextInjector,
  pkbReminderInjector,
  memoryV2StaticInjector,
  nowMdInjector,
  activeDocumentsInjector,
  documentCommentsInjector,
  subagentStatusInjector,
  slackMessagesInjector,
  threadFocusInjector,
];
