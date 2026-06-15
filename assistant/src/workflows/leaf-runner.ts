/**
 * Ephemeral leaf runner for the workflow orchestration engine.
 *
 * A workflow script (run in a sandbox by a later PR) fans out to many "leaf"
 * agents; the engine calls {@link runLeaf} once per leaf. A leaf is deliberately
 * cheap and ephemeral — it must NOT create a conversation row, a jsonl mirror, a
 * title-generation job, or broadcast turn lifecycle events. By default a leaf is
 * anonymous: a minimal task-scoped system prompt, no assistant identity, and no
 * memory pipeline.
 *
 * Setting `persona: true` opts a leaf into PERSONA mode: it carries the
 * assistant's identity system prompt (`buildSystemPrompt`) AND runs the same
 * memory-injection pipeline a main-agent turn uses
 * (`ConversationGraphMemory.prepareMemory`), so its output is authentically
 * "the assistant" — e.g. drafting a reply in the assistant's voice. This is the
 * costly path by design. Model resolution mirrors `mainAgent`: with no explicit
 * `profile`, the workspace `activeProfile` is used as the `overrideProfile`.
 * Persona leaves keep the same no-persistence guarantee — no conversation row
 * is ever created.
 *
 * Two leaf shapes are supported:
 *
 * - **Schema path** (`schema` provided, no `tools`): a single forced
 *   `tool_choice` provider call whose synthetic tool's input schema is the
 *   caller's Zod schema. The returned tool input is Zod-validated and returned
 *   as `output`. Copies the proven pattern from `memory/v2/router.ts` and
 *   `memory/graph/extraction.ts`.
 * - **Tool path** (`tools` provided, no `schema`): a real {@link AgentLoop} with
 *   a minimal task-scoped system prompt and a tool-executor restricted to the
 *   supplied registry tools. No conversation is bootstrapped — the loop runs
 *   over an in-memory message array and its final text is returned as `output`.
 *
 * Profile overrides are validated up front (a deliberate deviation from the
 * resolver's silent fall-through — an explicit script request must fail loudly)
 * and threaded through as the `overrideProfile` argument so the per-call-site
 * config resolution picks them up. Retry/rate-limit handling is NOT added here:
 * the configured provider is already wrapped by `RetryProvider`/`RateLimitProvider`.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type AgentEvent, AgentLoop } from "../agent/loop.js";
import { getConfig } from "../config/loader.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  isPersonalMemoryAllowed,
  type TrustContext,
} from "../daemon/trust-context.js";
import { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import {
  extractToolUse,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("workflow-leaf-runner");

/** Call site every leaf provider call resolves through (added in PR 5). */
const LEAF_CALL_SITE = "workflowLeaf" as const;

/** Tool name forced via `tool_choice` on the schema path. */
const SCHEMA_TOOL_NAME = "emit_result";

/**
 * Minimal anonymous system prompt for the tool path. Deliberately carries NO
 * assistant identity, persona, or workspace context — a leaf is a task-scoped
 * worker, not the assistant.
 */
const LEAF_SYSTEM_PROMPT =
  "You are a focused task worker. Complete the task described in the user " +
  "message using the available tools, then reply with the final result as " +
  "plain text. Be concise.";

/**
 * Resolve the system prompt and the (possibly memory-injected) message array
 * for a leaf. Anonymous leaves use the minimal task prompt and the raw prompt
 * message unchanged. Persona leaves assemble the assistant's identity system
 * prompt and run the main-agent memory-injection pipeline, REUSING
 * `buildSystemPrompt` and `ConversationGraphMemory.prepareMemory` — no fork.
 *
 * The memory pipeline keys off an ephemeral conversation id and is disposed in
 * a finally block; it reads the memory graph and prepends a `<memory>` block to
 * the messages WITHOUT creating any conversation row (consistent with the
 * anonymous path's no-persistence guarantee).
 */
async function resolveLeafContext(
  opts: RunLeafOptions,
): Promise<{ systemPrompt: string; messages: Message[] }> {
  const userMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: opts.prompt }] },
  ];

  if (!opts.persona) {
    return { systemPrompt: LEAF_SYSTEM_PROMPT, messages: userMessages };
  }

  const systemPrompt = buildSystemPrompt({
    trustContext: opts.trustContext,
    // A persona leaf is not an onboarding turn, and it must not emit the
    // first-run bootstrap block: keep it to the assistant's stable identity.
    excludeBootstrap: true,
  });

  const messages = await injectPersonaMemory(opts, userMessages);
  return { systemPrompt, messages };
}

/**
 * Run the main-agent memory-injection pipeline for a persona leaf and return
 * the messages with the retrieved `<memory>` block prepended. Constructs an
 * ephemeral, non-persisting {@link ConversationGraphMemory} handle keyed by a
 * synthetic id (it registers itself in the live-by-conversation map, so it is
 * disposed in `finally` to avoid leaking the handle). Best-effort: a retrieval
 * failure leaves the messages unchanged rather than failing the leaf.
 *
 * Gated by the personal-memory trust check — THE canonical gate
 * ({@link isPersonalMemoryAllowed}, which folds in `resolveTrustClass` and the
 * HTTP-auth-disabled dev bypass). A persona leaf retrieves the same private
 * user content (`<memory>` graph) a main-agent turn does, so it honors the same
 * gate the normal turn applies before `prepareMemory`
 * (`userPromptSubmitMemoryRetrieval`): an untrusted (non-guardian) requester's
 * persona leaf still gets the assistant's identity system prompt but NO personal
 * memory. Without this, a workflow launched by an untrusted actor whose manifest
 * grants `persona` could exfiltrate private memory in its output.
 */
async function injectPersonaMemory(
  opts: RunLeafOptions,
  messages: Message[],
): Promise<Message[]> {
  if (!isPersonalMemoryAllowed(opts.trustContext)) return messages;

  const config = getConfig();
  if (config.memory?.enabled === false) return messages;

  const ephemeralConversationId = `workflow-leaf:${randomUUID()}`;
  const graphMemory = new ConversationGraphMemory(ephemeralConversationId);
  // The memory pipeline broadcasts retrieval progress to the shared event hub
  // (matching the main-agent hook); a leaf has no per-turn event callback.
  const onEvent = (msg: ServerMessage): void => {
    broadcastMessage(msg);
  };
  // `prepareMemory` requires a non-aborting signal; reuse the caller's when
  // present so cancellation propagates.
  const signal = opts.signal ?? new AbortController().signal;
  try {
    const result = await graphMemory.prepareMemory(
      messages,
      config,
      signal,
      onEvent,
    );
    return result.runMessages;
  } catch (err) {
    log.warn({ err }, "Persona leaf memory injection failed (non-fatal)");
    return messages;
  } finally {
    graphMemory.dispose();
  }
}

/**
 * Thrown when {@link runLeaf} is asked to use an inference profile that does not
 * exist in `llm.profiles`. A DELIBERATE deviation from the resolver's silent
 * fall-through: an explicit script request must fail loudly rather than be
 * downgraded to the default profile without the author noticing.
 */
export class WorkflowUnknownProfileError extends Error {
  constructor(readonly profile: string) {
    super(
      `Workflow leaf requested inference profile "${profile}", which is not ` +
        `defined in llm.profiles.`,
    );
    this.name = "WorkflowUnknownProfileError";
  }
}

/** Options for a single leaf run. */
export interface RunLeafOptions {
  /** The task prompt handed to the leaf as the user message. */
  prompt: string;
  /** Optional human-readable label for logging/diagnostics. */
  label?: string;
  /**
   * When provided (and `tools` is absent), runs the schema path: a single
   * forced-tool-choice call whose returned input is validated against this
   * schema and returned as `output`.
   *
   * Accepts EITHER a host-side Zod schema (host callers) OR a plain JSON Schema
   * object. A workflow script runs inside the QuickJS sandbox and cannot hold a
   * Zod object (Zod is host-side), so a script's `leaf(prompt, { schema })`
   * crosses the sandbox→host boundary as a JSON-marshaled JSON Schema. The
   * runner duck-types the input and handles both shapes (see {@link runSchemaLeaf}).
   */
  schema?: z.ZodType | Record<string, unknown>;
  /**
   * When provided (and `schema` is absent), runs the tool path: an agent loop
   * restricted to exactly these registry tools. These are the resolved
   * {@link Tool} objects from `ResolvedCapabilities.tools`.
   */
  tools?: Tool[];
  /**
   * Optional inference-profile override. Validated against `llm.profiles`;
   * an unknown profile throws {@link WorkflowUnknownProfileError}. An explicit
   * profile ALWAYS wins over the persona default (see {@link persona}).
   */
  profile?: string;
  /**
   * Opt-in persona mode. When `true`, the leaf carries the assistant's identity
   * system prompt (`buildSystemPrompt`) AND runs the same memory-injection
   * pipeline a normal main-agent turn uses (`ConversationGraphMemory.prepareMemory`),
   * so its output is authentically "the assistant" (e.g. for drafting replies in
   * the assistant's voice). This is the costly path by design.
   *
   * Model resolution mirrors `mainAgent`: when no explicit {@link profile} is
   * given, the workspace `activeProfile` is used as the `overrideProfile`.
   *
   * When falsy (the default), the leaf stays ANONYMOUS: minimal task prompt, no
   * identity, no memory pipeline. Persona shares the anonymous path's
   * no-persistence guarantee — it never creates a conversation row.
   */
  persona?: boolean;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
  /** Trust/auth context for the run, forwarded to the agent loop. */
  trustContext: TrustContext;
}

/** Result of a single leaf run. */
export interface LeafResult {
  /**
   * The leaf's output — the Zod-validated object on the schema path, or the
   * final assistant text on the tool path.
   */
  output: unknown;
  /** Total input tokens across the leaf's provider call(s). */
  inputTokens: number;
  /** Total output tokens across the leaf's provider call(s). */
  outputTokens: number;
  /** Number of tool invocations the leaf made (always 0 on the schema path). */
  toolCallCount: number;
}

/**
 * Run a single ephemeral leaf agent. See the module doc for the two shapes and
 * the persistence guarantees (no conversation row, jsonl, title job, or
 * broadcast).
 */
export async function runLeaf(opts: RunLeafOptions): Promise<LeafResult> {
  if (opts.schema && opts.tools && opts.tools.length > 0) {
    throw new Error(
      "runLeaf: provide either `schema` (structured output) or `tools` " +
        "(agent loop), not both.",
    );
  }

  const overrideProfile = resolveLeafOverrideProfile(opts);

  // Dispatch on schema presence, NOT on a non-empty tool set: a schema leaf does
  // forced-tool-choice structured output; everything else runs the agent-loop
  // tool path, which handles an EMPTY tool array as a plain text leaf. Keying off
  // `tools.length > 0` would route a no-schema leaf with an empty resolved
  // toolset (e.g. the read-only baseline is momentarily empty if a schedule
  // fires before `initializeTools()` populates it) into `runSchemaLeaf` with no
  // schema, where `schemaToInputSchema(undefined)` throws.
  if (opts.schema !== undefined) {
    return runSchemaLeaf(opts, overrideProfile);
  }
  return runToolLeaf(opts, overrideProfile);
}

/**
 * Resolve the `overrideProfile` forwarded into the per-call-site config
 * resolution for a leaf.
 *
 * An explicit `opts.profile` is validated and always wins. Otherwise, for a
 * persona leaf, the resolution mirrors `mainAgent`: the workspace
 * `activeProfile` is used as the `overrideProfile` (the active profile reflects
 * the user's chat-model selection). Anonymous leaves with no explicit profile
 * resolve to `undefined` (shipped call-site defaults apply).
 */
function resolveLeafOverrideProfile(opts: RunLeafOptions): string | undefined {
  if (opts.profile !== undefined) {
    return validateProfile(opts.profile);
  }
  if (opts.persona) {
    // Mirror `mainAgent`: the workspace active profile floats above the
    // call-site default. Unlike an explicit request, a missing/deleted active
    // profile degrades gracefully (it is not statically validated) — a
    // non-existent `activeProfile` falls through to the shipped default rather
    // than throwing, matching the `mainAgent` resolver's tolerance for a stale
    // `activeProfile`.
    const activeProfile = getConfig().llm.activeProfile;
    return activeProfile != null && profileExists(activeProfile)
      ? activeProfile
      : undefined;
  }
  return undefined;
}

/**
 * Validate an explicit profile request against `llm.profiles`. Throws
 * {@link WorkflowUnknownProfileError} for an unknown profile — an explicit
 * script request must fail loudly rather than be silently downgraded.
 */
function validateProfile(profile: string): string {
  if (!profileExists(profile)) {
    throw new WorkflowUnknownProfileError(profile);
  }
  return profile;
}

function profileExists(profile: string): boolean {
  return profile in (getConfig().llm.profiles ?? {});
}

/**
 * Schema path: one forced-tool-choice provider call returning structured
 * output. Mirrors `runRouterBatch`/`extractGraphDiff`.
 */
async function runSchemaLeaf(
  opts: RunLeafOptions,
  overrideProfile: string | undefined,
): Promise<LeafResult> {
  const schema = opts.schema as z.ZodType | Record<string, unknown>;

  const { systemPrompt, messages } = await resolveLeafContext(opts);

  const provider = await getConfiguredProvider(LEAF_CALL_SITE, {
    ...(overrideProfile !== undefined ? { overrideProfile } : {}),
  });
  if (!provider) {
    throw new Error(
      `Workflow leaf provider unavailable for call site "${LEAF_CALL_SITE}".`,
    );
  }

  const tool: ToolDefinition = {
    name: SCHEMA_TOOL_NAME,
    description:
      "Return the result for this task. Call this tool exactly once with the " +
      "structured result.",
    input_schema: schemaToInputSchema(schema),
  };

  const response = await provider.sendMessage(messages, {
    tools: [tool],
    systemPrompt,
    config: {
      callSite: LEAF_CALL_SITE,
      tool_choice: { type: "tool" as const, name: SCHEMA_TOOL_NAME },
      // `provider` is a CallSiteConfiguredProvider holding our overrideProfile,
      // but it only injects that stored override when the per-call config omits
      // `callSite` — and we set `callSite` here to drive resolveCallSiteConfig.
      // So pass overrideProfile through explicitly (mirroring how AgentLoop
      // builds its provider config on the tool path), or an explicit/persona
      // profile selection is silently dropped and the leaf runs under the
      // default workflowLeaf profile.
      ...(overrideProfile !== undefined ? { overrideProfile } : {}),
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== SCHEMA_TOOL_NAME) {
    throw new Error(
      `Workflow leaf "${opts.label ?? "schema"}" returned no ` +
        `${SCHEMA_TOOL_NAME} tool_use block (stopReason: ${response.stopReason}).`,
    );
  }

  const parsed = validateSchemaOutput(schema, toolBlock.input);
  if (!parsed.success) {
    throw new Error(
      `Workflow leaf "${opts.label ?? "schema"}" output failed schema ` +
        `validation: ${parsed.error.message}`,
    );
  }

  return {
    output: parsed.data,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    toolCallCount: 0,
  };
}

/**
 * Tool path: a real agent loop with a restricted toolset and no conversation
 * persistence. The loop runs over an in-memory message array; its events are
 * consumed only to accumulate usage/tool-call counts. No DB row, jsonl, title
 * job, or broadcast is created.
 */
async function runToolLeaf(
  opts: RunLeafOptions,
  overrideProfile: string | undefined,
): Promise<LeafResult> {
  const tools = opts.tools ?? [];

  const { systemPrompt, messages } = await resolveLeafContext(opts);

  const provider = await getConfiguredProvider(LEAF_CALL_SITE, {
    ...(overrideProfile !== undefined ? { overrideProfile } : {}),
  });
  if (!provider) {
    throw new Error(
      `Workflow leaf provider unavailable for call site "${LEAF_CALL_SITE}".`,
    );
  }

  // Restrict execution to exactly the supplied tools. The agent loop calls
  // this back per tool_use; anything outside the set is a hard error (the
  // model cannot have been handed an out-of-set tool, so this is defense in
  // depth).
  const toolsByName = new Map<string, Tool>(tools.map((t) => [t.name, t]));

  // A synthetic conversation id is needed for the loop's internal bookkeeping
  // (compaction circuit breaker keying) but is NEVER persisted — no
  // conversation row is created for it.
  const ephemeralConversationId = `workflow-leaf:${randomUUID()}`;

  const loop = new AgentLoop({
    provider,
    systemPrompt,
    tools: tools as ToolDefinition[],
    toolExecutor: (name, input, onOutput) =>
      executeLeafTool(toolsByName, name, input, {
        ephemeralConversationId,
        // Bind leaf file tools to the WORKSPACE, not the daemon's cwd: the CLI
        // starts the daemon with `cwd: dirname(daemonBinary)`, so `process.cwd()`
        // is the install dir. File tools resolve relative paths and enforce the
        // sandbox boundary against this dir, so a workspace path would resolve
        // wrong / be rejected as out-of-bounds. Mirrors the scheduled-task path
        // (`runtime/routes/task-routes.ts`), which also uses `getWorkspaceDir()`.
        workingDir: getWorkspaceDir(),
        signal: opts.signal,
        onOutput,
        trustContext: opts.trustContext,
      }),
    conversationId: ephemeralConversationId,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallCount = 0;
  const onEvent = (event: AgentEvent): void => {
    if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
    } else if (event.type === "tool_use") {
      toolCallCount += 1;
    }
  };

  const result = await loop.run({
    messages,
    onEvent,
    requestId: ephemeralConversationId,
    trust: opts.trustContext,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(overrideProfile !== undefined ? { overrideProfile } : {}),
  });

  return {
    output: finalAssistantText(result.history),
    inputTokens,
    outputTokens,
    toolCallCount,
  };
}

/**
 * Execute one tool invocation for the tool path, restricted to the supplied
 * set. Builds a minimal {@link ToolContext} — the leaf is anonymous, runs in
 * the sandbox, and self-approves as the requested trust class (the workflow
 * manifest is the single consent point, resolved by the engine before the run).
 */
async function executeLeafTool(
  toolsByName: Map<string, Tool>,
  name: string,
  input: Record<string, unknown>,
  ctx: {
    ephemeralConversationId: string;
    workingDir: string;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    trustContext: TrustContext;
  },
): Promise<ToolExecutionResult> {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      content: `Tool "${name}" is not available to this workflow leaf.`,
      isError: true,
    };
  }

  const toolContext: ToolContext = {
    conversationId: ctx.ephemeralConversationId,
    workingDir: ctx.workingDir,
    requestId: ctx.ephemeralConversationId,
    trustClass: ctx.trustContext.trustClass,
    allowedToolNames: new Set(toolsByName.keys()),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
  };

  try {
    return await tool.execute(input, toolContext);
  } catch (err) {
    log.warn({ err, tool: name }, "Workflow leaf tool execution threw");
    return {
      content: `Tool "${name}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      isError: true,
    };
  }
}

/** Join the text blocks of the final assistant message in `history`. */
function finalAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("");
    return text.trim();
  }
  return "";
}

/**
 * A leaf's structured-output schema is EITHER a host-side Zod schema (passed by
 * a host caller) or a plain JSON Schema object (a script's `leaf(prompt,
 * { schema })` is JSON-marshaled across the sandbox→host boundary, since the
 * sandbox can't hold a Zod object). Duck-type the input: a Zod schema exposes a
 * `safeParse` method (and the internal `_zod` marker), a JSON Schema object does
 * not.
 */
function isZodSchema(
  schema: z.ZodType | Record<string, unknown>,
): schema is z.ZodType {
  return typeof (schema as { safeParse?: unknown }).safeParse === "function";
}

/**
 * Build the synthetic forced-tool's `input_schema` from the leaf's schema. A Zod
 * schema is converted via Zod 4's native `z.toJSONSchema` (mirrors
 * `scripts/generate-openapi.ts`), stripping the `$schema` key tool definitions
 * don't carry. A plain JSON Schema object is used directly (same `$schema`
 * strip for parity).
 */
function schemaToInputSchema(
  schema: z.ZodType | Record<string, unknown>,
): Record<string, unknown> {
  const converted = isZodSchema(schema)
    ? (z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
        string,
        unknown
      >)
    : schema;
  const { $schema: _dropped, ...rest } = converted;
  return rest;
}

/**
 * Validate the model's returned tool input against the leaf's schema. A Zod
 * schema validates directly; a plain JSON Schema object is reconstructed into a
 * Zod schema via `z.fromJSONSchema` first. Returns Zod's native `safeParse`
 * result so callers handle both shapes uniformly.
 */
function validateSchemaOutput(
  schema: z.ZodType | Record<string, unknown>,
  input: unknown,
) {
  const zodSchema = isZodSchema(schema) ? schema : z.fromJSONSchema(schema);
  return zodSchema.safeParse(input);
}
