/**
 * Ephemeral leaf runner for the workflow orchestration engine.
 *
 * A workflow script (run in a sandbox by a later PR) fans out to many "leaf"
 * agents; the engine calls {@link runLeaf} once per leaf. A leaf is deliberately
 * cheap and ephemeral — it must NOT create a conversation row, a jsonl mirror, a
 * title-generation job, or broadcast any events. It is the single-leaf
 * primitive: anonymous, with no assistant identity, no persona, and no
 * persistence. Persona leaves and concurrency are layered on by other PRs.
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
import type { TrustContext } from "../daemon/trust-context.js";
import {
  extractToolUse,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";

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
   */
  schema?: z.ZodType;
  /**
   * When provided (and `schema` is absent), runs the tool path: an agent loop
   * restricted to exactly these registry tools. These are the resolved
   * {@link Tool} objects from `ResolvedCapabilities.tools`.
   */
  tools?: Tool[];
  /**
   * Optional inference-profile override. Validated against `llm.profiles`;
   * an unknown profile throws {@link WorkflowUnknownProfileError}.
   */
  profile?: string;
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

  const overrideProfile = resolveOverrideProfile(opts.profile);

  if (opts.tools && opts.tools.length > 0) {
    return runToolLeaf(opts, overrideProfile);
  }
  return runSchemaLeaf(opts, overrideProfile);
}

/**
 * Validate an explicit profile request against `llm.profiles`. Returns the
 * profile name (to forward as `overrideProfile`) or `undefined` when none was
 * requested. Throws {@link WorkflowUnknownProfileError} for an unknown profile.
 */
function resolveOverrideProfile(
  profile: string | undefined,
): string | undefined {
  if (profile === undefined) return undefined;
  const profiles = getConfig().llm.profiles ?? {};
  if (!(profile in profiles)) {
    throw new WorkflowUnknownProfileError(profile);
  }
  return profile;
}

/**
 * Schema path: one forced-tool-choice provider call returning structured
 * output. Mirrors `runRouterBatch`/`extractGraphDiff`.
 */
async function runSchemaLeaf(
  opts: RunLeafOptions,
  overrideProfile: string | undefined,
): Promise<LeafResult> {
  const schema = opts.schema as z.ZodType;

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
    input_schema: zodToInputSchema(schema),
  };

  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: opts.prompt }] }],
    {
      tools: [tool],
      systemPrompt: LEAF_SYSTEM_PROMPT,
      config: {
        callSite: LEAF_CALL_SITE,
        tool_choice: { type: "tool" as const, name: SCHEMA_TOOL_NAME },
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== SCHEMA_TOOL_NAME) {
    throw new Error(
      `Workflow leaf "${opts.label ?? "schema"}" returned no ` +
        `${SCHEMA_TOOL_NAME} tool_use block (stopReason: ${response.stopReason}).`,
    );
  }

  const parsed = schema.safeParse(toolBlock.input);
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
    systemPrompt: LEAF_SYSTEM_PROMPT,
    tools: tools as ToolDefinition[],
    toolExecutor: (name, input, onOutput) =>
      executeLeafTool(toolsByName, name, input, {
        ephemeralConversationId,
        workingDir: process.cwd(),
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
    messages: [
      { role: "user", content: [{ type: "text", text: opts.prompt }] },
    ],
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
 * Convert a Zod schema into a JSON-schema `input_schema` object for a synthetic
 * tool. Uses Zod 4's native `z.toJSONSchema` (mirrors `scripts/generate-openapi.ts`)
 * and strips the `$schema` key, which tool definitions don't carry.
 */
function zodToInputSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
  const { $schema: _dropped, ...rest } = converted;
  return rest;
}
