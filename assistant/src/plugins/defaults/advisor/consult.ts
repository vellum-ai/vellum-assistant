/**
 * Run one advisor consult.
 *
 * Routed entirely through the assistant's own inference: `getConfiguredProvider`
 * resolves the general-purpose `inference` call site (with the advisor profile
 * applied as an `overrideProfile`) to a provider/model/credentials from the
 * configured profiles — managed-proxy or BYOK, no separate API key. The consult
 * then runs a tool-less, capped one-shot completion through `provider.sendMessage`
 * and returns the text.
 */

import { getConfig } from "../../../config/loader.js";
import type { LLMCallSite } from "../../../config/schemas/llm.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../../providers/provider-send-message.js";
import type {
  Message,
  ProviderEvent,
  ToolDefinition,
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
 * to `onText` so the tool-output drawer streams *throughout* the consult rather
 * than sitting silent until the final advice lands.
 *
 * Before web search the consult was a tool-less one-shot, so the only live
 * activity was the advice text. With full context + native web search the
 * advisor now searches (up to 5×) and reasons before writing — forwarding only
 * `text_delta` left the drawer blank for that whole prefix, which read as "not
 * streaming". We now also surface the reasoning summary (when the model emits
 * one) and a one-line note per web search. The complete guidance is still
 * returned by `consultAdvisor`; the renderer swaps it in once the tool result
 * arrives.
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
        if (typeof rawQuery === "string" && rawQuery.trim().length > 0) {
          onText(`\n🔎 Searched: ${rawQuery.trim()}\n`);
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
  // tool to a non-native provider would surface a client tool call this
  // one-shot consult cannot execute, so we gate strictly on the capability and
  // otherwise keep the consult tool-less.
  const webEnabled = provider.supportsNativeWebSearch === true;

  const { onText } = params;
  const response = await provider.sendMessage(messages, {
    systemPrompt: buildAdvisorSystem(
      params.systemPrompt,
      params.runtimeContext,
    ),
    ...(webEnabled ? { tools: [ADVISOR_WEB_SEARCH_TOOL] } : {}),
    // Stream the consult's activity live (advice text, reasoning summary, and a
    // note per web search) so the drawer isn't blank while the advisor searches
    // and reasons before writing its guidance. See `advisorActivitySink`.
    onEvent: onText ? advisorActivitySink(onText) : undefined,
    config: {
      callSite: ADVISOR_CALL_SITE,
      ...override,
      tool_choice: webEnabled ? { type: "auto" } : { type: "none" },
    },
    signal: withTimeout(params.signal, ADVISOR_CONFIG.timeoutMs),
  });

  const advice = extractAllText(response).trim();
  return advice.length > 0 ? advice : "(advisor returned no guidance)";
}
