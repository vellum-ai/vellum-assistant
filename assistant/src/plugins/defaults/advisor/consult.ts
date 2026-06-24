/**
 * Run one advisor consult.
 *
 * Routed entirely through the assistant's own inference: `getConfiguredProvider`
 * resolves the general-purpose `inference` call site (with the advisor profile
 * applied as an `overrideProfile`) to a provider/model/credentials from the
 * configured profiles — managed-proxy or BYOK, no separate API key.
 *
 * The consult runs through `provider.sendMessage` and returns the advice text.
 * It is a one-shot completion unless grounding tools are attached: `web_search`
 * (when the provider runs search server-side) and `read_file` (when a working
 * directory is known). `read_file` executes in the workspace, so the consult
 * then runs a bounded read loop — capped on total reads and turns — feeding each
 * file back to the advisor before it writes its guidance.
 */

import { getConfig } from "../../../config/loader.js";
import type { LLMCallSite } from "../../../config/schemas/llm.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../../providers/provider-send-message.js";
import type {
  ContentBlock,
  Message,
  ProviderEvent,
  ToolDefinition,
  ToolUseContent,
} from "../../../providers/types.js";
import { ADVISOR_CONFIG } from "./config.js";
import { advisorRequestText, buildAdvisorSystem } from "./steering.js";
import { toAdvisorMessages } from "./transcript.js";

// Dedicated advisor call site. Its default profile (`quality-optimized`) lives
// in CALL_SITE_DEFAULTS; a workspace overrides which profile the advisor runs
// on via `llm.advisorProfile`, which we float above the call-site layers.
const ADVISOR_CALL_SITE: LLMCallSite = "advisor";

/**
 * The single tool the consult may attach: a `web_search`-named tool that
 * provider-native search (Anthropic/OpenAI) substitutes for its server-side
 * web tool. Only passed when `provider.supportsNativeWebSearch` is true, so the
 * provider runs the search itself and returns results inline — no agent loop,
 * which keeps the consult a one-shot completion.
 */
const ADVISOR_WEB_SEARCH_TOOL: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information to ground your guidance.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

/**
 * A client-side tool that lets the advisor read files in the agent's workspace,
 * so it can verify the plan against the actual code instead of trusting the
 * transcript's summary. Only attached when the consult resolves a `workingDir`.
 *
 * Unlike `web_search` (which the provider runs server-side, keeping the consult
 * a one-shot), this tool executes in the daemon — so attaching it turns the
 * consult into a bounded read loop (see `consultAdvisor`). Reads are confined to
 * the working directory by `sandboxPolicy`, exactly like the agent's own
 * `file_read` tool.
 */
const ADVISOR_READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file in the agent's workspace to ground your guidance in the actual code rather than the transcript's summary. The path is relative to the agent's working directory (or absolute within it). Returns line-numbered text. Use `offset`/`limit` to page through a large file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file, relative to the working directory or absolute within it.",
      },
      offset: {
        type: "number",
        description: "1-indexed line to start reading from (optional).",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read (optional).",
      },
    },
    required: ["path"],
  },
};

/** Total file reads allowed across one consult. */
const ADVISOR_MAX_FILE_READS = 10;
/** Model turns that may request reads before the consult must conclude. */
const ADVISOR_MAX_TOOL_ITERATIONS = 12;
/** Per-read cap on the content fed back into the consult prompt. */
const ADVISOR_FILE_READ_CHAR_CAP = 12_000;

/**
 * Execute one advisor `read_file` call against the workspace. Path safety and
 * size limits are delegated to the same `sandboxPolicy` + `FileSystemOps` the
 * agent's `file_read` tool uses, so the advisor can never read outside the
 * working directory. Modules are pulled in via dynamic `import()` to avoid a
 * static cycle between this bootstrap-loaded plugin and the tools layer (the
 * same pattern `context-pack.ts` uses).
 */
async function readWorkspaceFileForAdvisor(
  input: Record<string, unknown>,
  workingDir: string,
): Promise<{ content: string; isError: boolean; path: string }> {
  const path = typeof input["path"] === "string" ? input["path"].trim() : "";
  if (!path) {
    return { content: "Error: path is required.", isError: true, path: "" };
  }
  try {
    const [{ FileSystemOps }, { sandboxPolicy }] = await Promise.all([
      import("../../../tools/shared/filesystem/file-ops-service.js"),
      import("../../../tools/shared/filesystem/path-policy.js"),
    ]);
    const ops = new FileSystemOps((candidate, opts) =>
      sandboxPolicy(candidate, workingDir, opts),
    );
    const result = ops.readFileSafe({
      path,
      offset: typeof input["offset"] === "number" ? input["offset"] : undefined,
      limit: typeof input["limit"] === "number" ? input["limit"] : undefined,
    });
    if (!result.ok) {
      const reason =
        result.error.message ?? result.error.code ?? "could not read file";
      return { content: `Error reading "${path}": ${reason}`, isError: true, path };
    }
    const { content } = result.value;
    const capped =
      content.length > ADVISOR_FILE_READ_CHAR_CAP
        ? `${content.slice(0, ADVISOR_FILE_READ_CHAR_CAP)}\n…(truncated — pass offset/limit to read further)`
        : content;
    return { content: capped, isError: false, path };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { content: `Error reading "${path}": ${reason}`, isError: true, path };
  }
}

/**
 * Resolve the routing override for the advisor consult. When the workspace has
 * set `llm.advisorProfile`, force it above the call-site layers so it is
 * authoritative; otherwise return `{}` so the `advisor` call site resolves to
 * its default profile.
 */
function advisorOverride(): {
  overrideProfile?: string;
  forceOverrideProfile?: boolean;
} {
  const advisorProfile = getConfig().llm.advisorProfile;
  return advisorProfile
    ? { overrideProfile: advisorProfile, forceOverrideProfile: true }
    : {};
}

export interface ConsultParams {
  systemPrompt: string | null;
  messages: ReadonlyArray<Message>;
  /**
   * The agent's runtime context (available tools and skills, workspace/project
   * context, recalled memory), gathered by the tool from its `ToolContext`.
   * Embedded in the advisor's system prompt so its advice is grounded in what
   * the agent can actually do. Omitted/null when nothing could be gathered.
   */
  runtimeContext?: string | null;
  /**
   * The agent's working directory. When provided, the consult attaches the
   * `read_file` tool so the advisor can open and read workspace files to ground
   * its guidance (path-confined to this directory). Omitted = no file access.
   */
  workingDir?: string;
  signal?: AbortSignal;
  /**
   * Optional sink for the advisor's live activity as it generates: incremental
   * advice text, the reasoning summary (when surfaced), and a note per web
   * search. Wiring this to the tool's `onOutput` surfaces the consult live as
   * `tool_output_chunk` while the advisor is still working; the complete
   * guidance is still returned as the resolved string. See `advisorActivitySink`.
   */
  onText?: (chunk: string) => void;
}

/** Combine the caller's signal with a consult timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Build the streaming sink for a consult: forward the advisor's live activity
 * to `onText` so the tool-output drawer streams throughout the consult instead
 * of sitting silent until the final advice lands.
 *
 * The consult searches the web (up to 5×) and reasons over full context before
 * writing its guidance. Forwarding the visible advice text alone would leave
 * the drawer blank for that whole prefix, so the sink also surfaces the
 * reasoning summary (when the model emits one) and a one-line note per web
 * search — a success note with the query, or a failure note when the search
 * errors. The complete guidance is still returned by `consultAdvisor`; the
 * renderer swaps it in once the tool result arrives.
 */
function advisorActivitySink(
  onText: (chunk: string) => void,
): (event: ProviderEvent) => void {
  return (event) => {
    switch (event.type) {
      case "text_delta":
        if (event.text) onText(event.text);
        break;
      case "thinking_delta":
        if (event.thinking) onText(event.thinking);
        break;
      case "server_tool_start":
        if (event.name === "web_search") onText("\n🔎 Searching the web…\n");
        break;
      case "server_tool_complete": {
        const rawQuery = event.resolvedInput?.["query"];
        const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
        if (event.isError) {
          // A failed search (e.g. `query_too_long`, `max_uses_exceeded`) must
          // not be announced as a success — the advisor proceeds without it.
          onText(
            query
              ? `\n⚠️ Web search failed: ${query}\n`
              : "\n⚠️ Web search failed.\n",
          );
        } else if (query) {
          onText(`\n🔎 Searched: ${query}\n`);
        }
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Returns the advisor's guidance text, or a short benign notice when the
 * advisor can't run. Callers should surface the string as a non-error tool
 * result so the executor continues regardless.
 */
export async function consultAdvisor(params: ConsultParams): Promise<string> {
  const history = toAdvisorMessages(params.messages);
  if (history.length === 0) {
    return "(advisor: no conversation context is available yet)";
  }

  const override = advisorOverride();

  const provider = await getConfiguredProvider(ADVISOR_CALL_SITE, override);
  if (!provider) {
    return "(advisor unavailable: no inference provider is configured)";
  }

  // Append the consult instruction as the final user turn, then run a
  // completion through the resolved provider. No `max_tokens` is set, so the
  // resolver applies the profile's normal output budget rather than an
  // advisor-specific cap.
  const messages: Message[] = [...history, userMessage(advisorRequestText())];

  // Give the advisor live web access when — and only when — the resolved
  // provider runs search server-side (provider-native). Passing a `web_search`
  // tool to a non-native provider would surface a client tool call this consult
  // cannot execute, so gate strictly on the capability.
  const webEnabled = provider.supportsNativeWebSearch === true;
  // Let the advisor read workspace files when a working directory is known.
  const canReadFiles =
    typeof params.workingDir === "string" && params.workingDir.length > 0;

  const tools: ToolDefinition[] = [];
  if (webEnabled) tools.push(ADVISOR_WEB_SEARCH_TOOL);
  if (canReadFiles) tools.push(ADVISOR_READ_FILE_TOOL);

  const { onText } = params;
  // One deadline for the whole consult, shared across every turn of the read
  // loop below so reads can't extend it past the configured timeout.
  const consultSignal = withTimeout(params.signal, ADVISOR_CONFIG.timeoutMs);
  const sendOptions = {
    systemPrompt: buildAdvisorSystem(params.systemPrompt, params.runtimeContext, {
      canReadFiles,
      webSearch: webEnabled,
    }),
    ...(tools.length > 0 ? { tools } : {}),
    // Stream the consult's activity live (advice text, reasoning summary, and a
    // note per web search) so the drawer isn't blank while the advisor searches
    // and reasons before writing its guidance. See `advisorActivitySink`.
    onEvent: onText ? advisorActivitySink(onText) : undefined,
    config: {
      callSite: ADVISOR_CALL_SITE,
      ...override,
      tool_choice: tools.length > 0 ? { type: "auto" } : { type: "none" },
    },
    signal: consultSignal,
  };

  // The consult is a one-shot completion unless `read_file` is attached. Web
  // search resolves server-side and never pauses the turn, so a `tool_use` stop
  // means the advisor wants to read a file: execute it in the workspace, feed
  // the result back, and continue. The loop is bounded by total reads and turns
  // so the consult stays fast. Advice text from every turn is accumulated (the
  // model may write before reading), and the same text streams to the drawer.
  const adviceParts: string[] = [];
  let reads = 0;
  let response = await provider.sendMessage(messages, sendOptions);

  for (
    let turn = 0;
    response.stopReason === "tool_use" && turn < ADVISOR_MAX_TOOL_ITERATIONS;
    turn++
  ) {
    const turnText = extractAllText(response).trim();
    if (turnText) adviceParts.push(turnText);

    const fileReads = response.content.filter(
      (block): block is ToolUseContent =>
        block.type === "tool_use" && block.name === "read_file",
    );
    if (fileReads.length === 0) break; // nothing client-side to satisfy

    messages.push({ role: "assistant", content: response.content });
    const toolResults: ContentBlock[] = [];
    for (const call of fileReads) {
      if (reads >= ADVISOR_MAX_FILE_READS || consultSignal.aborted) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content:
            "Error: file-read budget for this consult is exhausted; give your guidance with what you have.",
          is_error: true,
        });
        continue;
      }
      reads++;
      const { content, isError, path } = await readWorkspaceFileForAdvisor(
        call.input,
        params.workingDir as string,
      );
      onText?.(isError ? `\n⚠️ Couldn't read ${path || "file"}\n` : `\n📄 Read ${path}\n`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
    if (consultSignal.aborted) break;
    response = await provider.sendMessage(messages, sendOptions);
  }

  const finalText = extractAllText(response).trim();
  if (finalText) adviceParts.push(finalText);

  const advice = adviceParts.join("\n\n").trim();
  return advice.length > 0 ? advice : "(advisor returned no guidance)";
}
