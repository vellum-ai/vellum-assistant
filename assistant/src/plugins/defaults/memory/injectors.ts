/**
 * `default-memory` plugin injectors — the personal-memory per-turn injections.
 *
 * Contributes the PKB `<knowledge_base>` block, the PKB `<system_reminder>`
 * (with hybrid-search hints), and the memory-v2 static `<info>` block. Each
 * reads its inputs directly off the {@link TurnContext} (and the workspace
 * memory/PKB files), runs its own gating (injection mode, the personal-memory
 * trust gate, the v2 cutover guard, null-input short-circuits), and returns an
 * {@link InjectionBlock} with the placement that yields the canonical
 * positional semantics.
 *
 * `defaultMemoryPlugin` contributes these (alongside the memory-v3 injectors in
 * `v3/injector.ts`) to the global injector registry
 * (`plugins/injector-registry.ts`), which unions every plugin's injectors and
 * sorts by `order` into the single sequence `applyRuntimeInjections` walks each
 * turn. The shared ordering contract lives in {@link DEFAULT_INJECTOR_ORDER}.
 */

import { resolve } from "node:path";

import type { Message } from "@vellumai/plugin-api";

import type { InjectionMatcher } from "../../../context/strip-injections.js";
import { getInContextPkbPaths } from "../../../daemon/pkb-context-tracker.js";
import { buildPkbReminder } from "../../../daemon/pkb-reminder-builder.js";
import {
  isPersonalMemoryAllowed,
  type TrustContext,
} from "../../../daemon/trust-context.js";
import { getLogger } from "../../../util/logger.js";
import { getSandboxWorkingDir } from "../../../util/platform.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { hasInjectedUserTextBlock } from "../injection-presence.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";
import { getMemoryConfig } from "./config.js";
import { getLiveGraphMemory } from "./graph/conversation-graph-memory.js";
import { getPkbAutoInjectList } from "./pkb/autoinject.js";
import { readPkbContext } from "./pkb/context.js";
import { searchPkbFiles } from "./pkb/pkb-search.js";
import { getPkbRoot, PKB_WORKSPACE_SCOPE } from "./pkb/types.js";
import { readMemoryV2StaticContent } from "./v2/static-context.js";

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
 * v2 read-side cutover guard. Under v2 both `pkb-context` and `pkb-reminder`
 * silence themselves entirely — the `<knowledge_base>` content and the
 * generic recall/remember nudge are both supplanted by the v2 static
 * `<memory>` block. NOW.md is workspace state independent of PKB and fires
 * unchanged.
 */
function isPkbInjectionSilencedByV2(): boolean {
  return getMemoryConfig().v2.enabled;
}

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
 * handle ({@link getLiveGraphMemory}) — the memory plugin's hook records it
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
 * The `default-memory` plugin's personal-memory injectors, in ascending
 * `order`. `defaultMemoryPlugin` contributes these alongside the memory-v3
 * injectors; the registry sorts the union by `order` (see
 * {@link DEFAULT_INJECTOR_ORDER}), so this array's literal order is only a
 * readability convenience.
 */
export const memoryInjectors: Injector[] = [
  pkbContextInjector,
  pkbReminderInjector,
  memoryV2StaticInjector,
];
