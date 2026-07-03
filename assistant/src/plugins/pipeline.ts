/**
 * Plugin hook runner.
 *
 * A "hook" is a named lifecycle event (`user-prompt-submit`, `post-tool-use`,
 * ...) that every registered plugin may handle. The runner walks each plugin's
 * hook for a given event in registration order, threading a context value
 * through the chain so hooks can observe and transform it. Each hook receives
 * an isolated draft of the current context. A hook either mutates the draft in
 * place (returning `void`) or returns a partial context whose fields are merged
 * onto the draft. Failed hook drafts are discarded.
 *
 * `getHooksFor` is now async — it pulls user-land hooks from the mtime
 * cache (filesystem-as-truth) and default plugin hooks from the registry
 * in a single unified call.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import { makeHookBroadcast } from "../hooks/hook-broadcast.js";
import { getHookEntriesFor } from "../hooks/registry.js";
import type { HookName } from "../plugin-api/constants.js";
import { getLogger } from "../util/logger.js";
import type { HookEntry } from "./types.js";

// ─── Hook runner ────────────────────────────────────────────────────────────

const log = getLogger("plugin-pipeline");

function isPluginLogger(value: unknown): value is {
  info: unknown;
  warn: unknown;
  error: unknown;
  debug: unknown;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { info?: unknown }).info === "function" &&
    typeof (value as { warn?: unknown }).warn === "function" &&
    typeof (value as { error?: unknown }).error === "function" &&
    typeof (value as { debug?: unknown }).debug === "function"
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneHookValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error || isPluginLogger(value)) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneHookValue(item, seen));
    }
    return copy as T;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, mapValue] of value) {
      copy.set(cloneHookValue(key, seen), cloneHookValue(mapValue, seen));
    }
    return copy as T;
  }

  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(cloneHookValue(item, seen));
    }
    return copy as T;
  }

  if (!isPlainObject(value)) return value;

  const copy: Record<PropertyKey, unknown> = {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = cloneHookValue(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return copy as T;
}

/**
 * Execute a hook chain: walk every registered plugin's hook for `name` in
 * registration order, threading `initialCtx` through each. Hooks may either
 * mutate their draft context in place (returning `void`) or return a partial
 * context whose fields are merged onto the draft — keys the hook returns
 * overwrite the running context, every other field is preserved. If a hook
 * throws, its draft is discarded and the next hook receives the last
 * successfully committed context. The final context after the chain settles is
 * returned.
 *
 * When `initialCtx` carries a `conversationId`, it is passed to
 * {@link getHookEntriesFor}, which resolves the conversation's per-chat plugin
 * scope (memory, then DB) and skips a hook whose contributing plugin is outside
 * the effective set. Contexts without a `conversationId` impose no restriction —
 * every globally-enabled plugin's hook runs.
 *
 * Before each hook runs, the pipeline stamps a `broadcast` capability onto its
 * (freshly-cloned) draft, bound to the hook's owner and — when the context
 * carries one — its `conversationId`. A hook calls `ctx.broadcast(detail)` to
 * emit a transient `hook_event` attributed to itself; it cannot pick the event
 * type, conversation, or owner. Every hook context receives it, so any
 * lifecycle hook can surface progress. Contexts that type `broadcast` (today,
 * `UserPromptSubmitContext`) expose it to hook authors directly.
 *
 * @param name        The hook identifier — pick one from {@link HOOKS}.
 * @param initialCtx  Context the first hook receives.
 * @returns The final context after the chain settles. Same reference as
 *          `initialCtx` when no plugin registers `name`.
 */
export async function runHook<TCtx>(
  name: HookName,
  initialCtx: TCtx,
): Promise<TCtx> {
  const conversationId = extractConversationId(initialCtx);
  let entries: HookEntry<TCtx>[];
  try {
    entries = await getHookEntriesFor<TCtx>(name, { conversationId });
  } catch (err) {
    log.error(
      { err, hookName: name },
      "plugin hook discovery failed — proceeding without hooks",
    );
    return initialCtx;
  }

  let active = initialCtx;
  for (const { fn, owner } of entries) {
    const draft = cloneHookValue(active);
    // Stamp a per-hook broadcast bound to this hook's owner and the
    // conversation resolved above (most hooks run inside one; hooks without a
    // `conversationId` emit an unscoped `hook_event`).
    (
      draft as { broadcast?: (detail: Record<string, unknown>) => void }
    ).broadcast = makeHookBroadcast({ conversationId, hookName: name, owner });
    try {
      const result = await fn(draft);
      if (result !== undefined) {
        active = { ...draft, ...result };
      } else {
        active = draft;
      }
    } catch (err) {
      log.error(
        { err, hookName: name, owner },
        "plugin hook failed — proceeding with current context",
      );
    }
  }
  return active;
}

/** The `conversationId` off a hook context, when it carries one as a string. */
function extractConversationId(ctx: unknown): string | undefined {
  const conversationId = (ctx as { conversationId?: unknown } | null)
    ?.conversationId;
  return typeof conversationId === "string" ? conversationId : undefined;
}
