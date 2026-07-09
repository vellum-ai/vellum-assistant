/**
 * `workspace` plugin injectors.
 *
 * Contributes the workspace-grounding per-turn injections: the disk-pressure
 * cleanup warning, the `<workspace>` top-level directory context, the
 * config-quarantine notice, the config-validation-reset notice, and the NOW.md
 * scratchpad. Each reads its inputs
 * directly off the {@link TurnContext} (or the workspace files) and runs its own
 * gating; see {@link DEFAULT_INJECTOR_ORDER} for the global ordering contract.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";

import type { Message } from "@vellumai/plugin-api";

import { getConfig } from "../../../config/loader.js";
import type { InjectionMatcher } from "../../../context/strip-injections.js";
import { findConversationOrSubagent } from "../../../daemon/conversation-registry.js";
import { resolveWorkspaceTopLevelContext } from "../../../daemon/conversation-workspace.js";
import { readNowScratchpad } from "../../../daemon/now-scratchpad.js";
import { isPersonalMemoryAllowed } from "../../../daemon/trust-context.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import {
  getConfigQuarantineNoticePath,
  getConfigValidationResetNoticePath,
} from "../../../util/platform.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { hasInjectedUserTextBlock } from "../injection-presence.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";

export const DISK_PRESSURE_WARNING_PROMPT = `<disk_pressure_warning>
Storage is critically low and normal work is suspended until space is freed.

Your first user-visible paragraph must warn the user that storage is critically low and normal work is suspended.

Before taking cleanup actions, call \`skill_load\` with \`skill: "system-storage-cleanup"\` and follow the cleanup skill.

Unrelated work remains blocked until disk usage drops below the critical threshold or the guardian explicitly overrides the lock. Background processes and trusted-contact messages remain blocked while this cleanup mode is active.
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
 * Maximum age of a config-validation-reset notice before it is considered stale.
 * A backstop only: a validation reset is recoverable, so the config loader
 * clears the sentinel the moment the config validates cleanly again — this
 * age-out just bounds a notice whose config is never re-loaded/fixed.
 */
const CONFIG_VALIDATION_RESET_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Shape of the config-validation-reset notice sentinel written by the config loader. */
interface ConfigValidationResetNotice {
  resetAt: string;
  invalidPaths: string[];
}

/**
 * Read and validate the config-validation-reset notice sentinel. Returns the
 * parsed notice when the file exists and carries the expected fields, otherwise
 * `null`. Best-effort: any read/parse error is swallowed and treated as absent.
 */
function readConfigValidationResetNotice(): ConfigValidationResetNotice | null {
  const noticePath = getConfigValidationResetNoticePath();
  if (!existsSync(noticePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(noticePath, "utf-8"));
    if (parsed == null || typeof parsed !== "object") return null;
    const { resetAt, invalidPaths } = parsed as Record<string, unknown>;
    if (typeof resetAt !== "string") return null;
    const paths = Array.isArray(invalidPaths)
      ? invalidPaths.filter((p): p is string => typeof p === "string")
      : [];
    return { resetAt, invalidPaths: paths };
  } catch {
    return null;
  }
}

/**
 * `config-validation-reset-notice` injector — order 26, prepend-user-tail.
 *
 * Surfaces a recent config-validation reset to the agent. When `config.json`
 * parses as JSON but fails schema validation hard enough that the loader falls
 * back to full defaults (see `config/loader.ts` `recordConfigValidationReset`),
 * settings the user never touched can silently revert — e.g. an unknown
 * `llm.callSites` key unmasks a `superRefine` violation on the strip-and-reparse
 * and the whole config resets, flipping a managed email/OAuth service mode back
 * to `your-own`. That reset is otherwise invisible (warn-only logs). This
 * injector reads the sentinel and, when it is younger than
 * {@link CONFIG_VALIDATION_RESET_NOTICE_MAX_AGE_MS}, injects a short block so the
 * agent can explain a setting or connection that changed without the user asking
 * — the on-disk config is intact, so recovery is fixing the flagged entries.
 *
 * Mirrors {@link configQuarantineNoticeInjector}: guardian-only (workspace paths
 * and settings state are not for non-guardian actors), active in both `full` and
 * `minimal` mode, and non-persisted so it stops appearing once the loader clears
 * the sentinel (config re-validates) or it ages out.
 */
const configValidationResetNoticeInjector: Injector = {
  name: "config-validation-reset-notice",
  order: DEFAULT_INJECTOR_ORDER.configValidationResetNotice,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (ctx.trust.trustClass !== "guardian") return null;

    const notice = readConfigValidationResetNotice();
    if (!notice) return null;

    const resetAtMs = Date.parse(notice.resetAt);
    const ageMs = Number.isNaN(resetAtMs)
      ? Number.POSITIVE_INFINITY
      : Date.now() - resetAtMs;
    if (ageMs > CONFIG_VALIDATION_RESET_NOTICE_MAX_AGE_MS) {
      try {
        rmSync(getConfigValidationResetNoticePath(), { force: true });
      } catch {
        // Best-effort cleanup — a failed delete just means we re-check next turn.
      }
      return null;
    }

    const invalidList =
      notice.invalidPaths.length > 0
        ? notice.invalidPaths.join(", ")
        : "(top-level)";
    const text =
      `<config_reset_notice>\n` +
      `The user's config.json failed schema validation and was reset to ` +
      `defaults at ${notice.resetAt}, so settings the user did not change may ` +
      `have silently reverted — including managed email/OAuth service modes ` +
      `(a managed connection can flip back to "your-own" and break), model ` +
      `choices, and other customizations. The on-disk config.json is intact; ` +
      `the invalid entries just need fixing for the saved values to take ` +
      `effect again. Invalid config path(s): ${invalidList}.\n\n` +
      `If the user reports a connection, setting, or integration that broke or ` +
      `changed on its own — especially email/Outlook/OAuth — do NOT trust ` +
      `memory or the Connected Services block: run a live check ` +
      `(\`assistant oauth status <provider>\`), explain this reset, and help ` +
      `them fix the flagged config entries. Otherwise mention it proactively ` +
      `only when clearly relevant — do not interrupt unrelated work.\n` +
      `</config_reset_notice>`;
    return {
      id: "config-validation-reset-notice",
      text,
      placement: "prepend-user-tail",
    };
  },
};

/** Block prefixes that mark a persisted NOW.md injection. */
const NOW_MD_BLOCK_PREFIXES = [
  "<NOW.md Always keep this up to date",
  "<now_scratchpad>", // backward-compat: pre-rename history
] as const;

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
 * `now-md` injector — order 40, after-memory-prefix.
 *
 * Injects the NOW.md scratchpad content as
 * `<NOW.md Always keep this up to date; keep under 10 lines>...` after any
 * memory-prefix blocks. NOW.md is workspace state independent of PKB, so it
 * lives in the workspace plugin even though it splices at the memory boundary.
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

/** The `workspace` plugin's runtime injectors, in ascending `order`. */
export const workspaceInjectors: Injector[] = [
  diskPressureWarningInjector,
  workspaceContextInjector,
  configQuarantineNoticeInjector,
  configValidationResetNoticeInjector,
  nowMdInjector,
];
