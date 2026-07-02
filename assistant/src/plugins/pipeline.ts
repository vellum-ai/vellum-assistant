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

import { getHooksFor } from "../hooks/registry.js";
import type { HookName } from "../plugin-api/constants.js";
import { getLogger } from "../util/logger.js";
import { resolveConversationPluginScope } from "./enabled-plugin-scope.js";
import type { HookFunction } from "./types.js";

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
 * When `initialCtx` carries a `conversationId`, the per-chat plugin scope is
 * resolved from it (memory, then DB) via {@link resolveConversationPluginScope}
 * and applied under the hood: a hook whose contributing plugin is outside the
 * conversation's effective set is skipped for this run. Contexts without a
 * `conversationId` (or when no resolver is registered) impose no restriction —
 * every globally-enabled plugin's hook runs.
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
  const effectiveEnabledPlugins = resolvePluginScopeFromContext(initialCtx);
  let hooks: HookFunction<TCtx>[];
  try {
    hooks = await getHooksFor<TCtx>(name, effectiveEnabledPlugins);
  } catch (err) {
    log.error(
      { err, hookName: name },
      "plugin hook discovery failed — proceeding without hooks",
    );
    return initialCtx;
  }

  let active = initialCtx;
  for (const hook of hooks) {
    const draft = cloneHookValue(active);
    try {
      const result = await hook(draft);
      if (result !== undefined) {
        active = { ...draft, ...result };
      } else {
        active = draft;
      }
    } catch (err) {
      log.error(
        { err, hookName: name },
        "plugin hook failed — proceeding with current context",
      );
    }
  }
  return active;
}

/**
 * Derive the per-chat plugin scope from a hook context: when it carries a
 * string `conversationId`, resolve the conversation's effective set via the
 * registered resolver; otherwise return `null` (no per-chat restriction).
 */
function resolvePluginScopeFromContext(ctx: unknown): Set<string> | null {
  const conversationId = (ctx as { conversationId?: unknown } | null)
    ?.conversationId;
  return typeof conversationId === "string"
    ? resolveConversationPluginScope(conversationId)
    : null;
}
