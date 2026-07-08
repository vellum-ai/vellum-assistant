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
 * `getHooksFor` is now async — it pulls user-land hooks from the plugin
 * cache (filesystem-as-truth via the source-versions reconcile) and default
 * plugin hooks from the registry
 * in a single unified call.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import { makeHookBroadcast } from "../hooks/hook-broadcast.js";
import { makeHookLogger } from "../hooks/hook-logger.js";
import { getHookEntriesFor } from "../hooks/registry.js";
import type { BaseHookContext } from "../hooks/types.js";
import { type HookName, HOOKS } from "../plugin-api/constants.js";
import type { ContentBlock } from "../providers/types.js";
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
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Error || isPluginLogger(value)) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }

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

  if (!isPlainObject(value)) {
    return value;
  }

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

// ─── Hook output sanitization ────────────────────────────────────────────────

/**
 * Hook-output fields the loop folds back into the turn verbatim — a malformed
 * message here fails every subsequent provider call, so each is validated
 * after every hook commit.
 */
const HOOK_MESSAGE_FIELDS: Partial<
  Record<
    HookName,
    { messageArrays?: string[]; blockArrays?: string[]; toolResults?: string[] }
  >
> = {
  [HOOKS.USER_PROMPT_SUBMIT]: { messageArrays: ["latestMessages"] },
  [HOOKS.POST_COMPACT]: { messageArrays: ["history"] },
  [HOOKS.POST_MODEL_CALL]: {
    messageArrays: ["messages"],
    blockArrays: ["content"],
  },
  [HOOKS.POST_TOOL_USE]: { toolResults: ["toolResponse"] },
};

const VALID_MESSAGE_ROLES = new Set(["user", "assistant"]);

/** Requires the `source` fields media resolution dereferences unguarded. */
function isMediaSource(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const source = value as Record<string, unknown>;
  if (source.type === "base64") {
    return (
      typeof source.data === "string" && typeof source.media_type === "string"
    );
  }
  if (source.type === "workspace_ref") {
    return (
      typeof source.attachmentId === "string" &&
      typeof source.media_type === "string" &&
      typeof source.sizeBytes === "number"
    );
  }
  return false;
}

/**
 * Requires the fields the loop and serializers read off each known block type
 * without guards (e.g. `block.id.length` on every tool_use). Unknown block
 * types pass — serializers already drop them safely.
 */
function isBlockish(block: unknown): block is ContentBlock {
  if (
    block === null ||
    typeof block !== "object" ||
    typeof (block as { type?: unknown }).type !== "string"
  ) {
    return false;
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string";
    case "thinking":
      return typeof b.thinking === "string" && typeof b.signature === "string";
    case "redacted_thinking":
      return typeof b.data === "string";
    case "tool_use":
    case "server_tool_use":
      return (
        typeof b.id === "string" &&
        typeof b.name === "string" &&
        typeof b.input === "object" &&
        b.input !== null
      );
    case "tool_result":
      // String content only (serializers concatenate it); rich content lives
      // in contentBlocks, validated recursively because media resolution
      // recurses into it.
      return (
        typeof b.tool_use_id === "string" &&
        typeof b.content === "string" &&
        (b.contentBlocks === undefined ||
          (Array.isArray(b.contentBlocks) && b.contentBlocks.every(isBlockish)))
      );
    case "web_search_tool_result":
      // `content` is an opaque provider-specific payload — unchecked.
      return typeof b.tool_use_id === "string";
    case "image":
    case "file":
      return isMediaSource(b.source);
    default:
      return true;
  }
}

/** A message whose shape the loop and serializers can consume safely. */
function isValidMessage(item: unknown): boolean {
  if (item === null || typeof item !== "object") {
    return false;
  }
  const msg = item as { role?: unknown; content?: unknown };
  return (
    typeof msg.role === "string" &&
    VALID_MESSAGE_ROLES.has(msg.role) &&
    Array.isArray(msg.content) &&
    msg.content.every(isBlockish)
  );
}

/**
 * Detect malformed message data in a hook's output. Read-only: a non-empty
 * result means the caller discards the hook's entire mutation and keeps the
 * previous context.
 */
function findHookOutputIssues<TInput extends object>(
  name: HookName,
  ctx: TInput,
): string[] {
  const spec = HOOK_MESSAGE_FIELDS[name];
  if (!spec) {
    return [];
  }
  const issues: string[] = [];
  const rec = ctx as Record<string, unknown>;

  for (const field of spec.messageArrays ?? []) {
    const value = rec[field];
    if (!Array.isArray(value)) {
      issues.push(`${field}: not an array`);
      continue;
    }
    for (let i = 0; i < value.length; i++) {
      if (!isValidMessage(value[i])) {
        issues.push(`${field}[${i}]: malformed message`);
      }
    }
  }

  for (const field of spec.blockArrays ?? []) {
    const value = rec[field];
    if (!Array.isArray(value)) {
      issues.push(`${field}: not an array`);
      continue;
    }
    for (let i = 0; i < value.length; i++) {
      if (!isBlockish(value[i])) {
        issues.push(`${field}[${i}]: malformed content block`);
      }
    }
  }

  for (const field of spec.toolResults ?? []) {
    const value = rec[field] as { type?: unknown } | null;
    // Only a client tool_result can pair back to the assistant's tool_use;
    // a server-tool web_search_tool_result replacement is rejected too.
    if (!isBlockish(value) || value.type !== "tool_result") {
      issues.push(`${field}: not a tool_result`);
    }
  }

  return issues;
}

// ─── Hook execution timeout ──────────────────────────────────────────────────

/**
 * Time-box for a single hook invocation: the try/catch contains throws but
 * not hangs.
 *
 * Covers async hangs only: a CPU-bound synchronous loop never yields to the
 * event loop, so the timeout cannot fire until it returns. Preempting that
 * needs worker-thread isolation, which the in-process hook contract (contexts
 * carry non-cloneable capabilities like `logger`/`broadcast`) does not
 * currently allow.
 */
export const HOOK_TIMEOUT_MS = 30_000;

export async function callWithTimeout<T>(
  run: () => Promise<T> | T,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = Promise.resolve().then(run);
    // Absorb the abandoned hook's late rejection if the timeout wins.
    work.catch(() => {});
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
 * Fail-open guards: a hook whose output carries malformed message data
 * ({@link findHookOutputIssues}) has its entire mutation discarded, and every
 * hook is time-boxed so a hung hook cannot block the turn.
 *
 * When `initialCtx` carries a `conversationId`, it is passed to
 * {@link getHookEntriesFor}, which resolves the conversation's per-chat plugin
 * scope (memory, then DB) and skips a hook whose contributing plugin is outside
 * the effective set. Contexts without a `conversationId` impose no restriction —
 * every globally-enabled plugin's hook runs.
 *
 * Before each hook runs, the pipeline stamps the {@link BaseHookContext}
 * capabilities onto its (freshly-cloned) draft, both bound to that hook's
 * identity: `broadcast` emits a `hook_event` attributed to the hook's owner
 * (and the context's `conversationId`, when present), and `logger` is a child
 * pre-tagged with the hook name, owner, and conversation / request identity.
 * Because the pipeline supplies them, call sites construct the per-hook
 * `XInputContext` shapes and never provide these fields themselves.
 *
 * @param name        The hook identifier — pick one from {@link HOOKS}.
 * @param initialCtx  Input context the first hook receives (the hook sees it
 *                    with the {@link BaseHookContext} capabilities added).
 * @returns The final context after the chain settles. Same reference as
 *          `initialCtx` when no plugin registers `name`.
 */
export async function runHook<TInput extends object>(
  name: HookName,
  initialCtx: TInput,
): Promise<TInput> {
  const conversationId = extractStringField(initialCtx, "conversationId");
  const requestId = extractStringField(initialCtx, "requestId");
  let entries: HookEntry<TInput & BaseHookContext>[];
  try {
    entries = await getHookEntriesFor<TInput & BaseHookContext>(name, {
      conversationId,
    });
  } catch (err) {
    log.error(
      { err, hookName: name },
      "plugin hook discovery failed — proceeding without hooks",
    );
    return initialCtx;
  }

  let active: TInput = initialCtx;
  for (const { fn, owner } of entries) {
    const draft = {
      ...cloneHookValue(active),
      logger: makeHookLogger({
        hookName: name,
        owner,
        conversationId,
        requestId,
      }),
      broadcast: makeHookBroadcast({ conversationId, hookName: name, owner }),
    };
    try {
      const result = await callWithTimeout(
        () => fn(draft),
        HOOK_TIMEOUT_MS,
        `plugin hook '${name}' (${owner.id}) timed out after ${HOOK_TIMEOUT_MS}ms`,
      );
      const candidate = result !== undefined ? { ...draft, ...result } : draft;
      const issues = findHookOutputIssues(name, candidate);
      if (issues.length > 0) {
        log.error(
          { hookName: name, owner, issues },
          "plugin hook produced malformed message data — skipping this hook",
        );
      } else {
        active = candidate;
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

/** A string-valued field off a hook context, when it carries one. */
function extractStringField(ctx: unknown, field: string): string | undefined {
  const value = (ctx as Record<string, unknown> | null)?.[field];
  return typeof value === "string" ? value : undefined;
}
