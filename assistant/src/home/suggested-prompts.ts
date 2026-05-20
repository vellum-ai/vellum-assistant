/**
 * Suggested prompt producer for the Home feed.
 *
 * Returns an array of `SuggestedPrompt` items shown at the top of the
 * Home page as conversation starters (e.g. "Connect Gmail", "Add Slack").
 *
 * Two sources of prompts:
 *   - **Deterministic** — derived from missing OAuth connections.
 *   - **Assistant-generated** — contextual suggestions from the LLM
 *     based on what's relevant to the user.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { isProviderConnected, listProviders } from "../oauth/oauth-store.js";
import { resolvePersonaContext } from "../prompts/persona-resolver.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { getProvider } from "../providers/registry.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import type { SuggestedPrompt } from "./feed-types.js";

const log = getLogger("suggested-prompts");

/**
 * Map of provider keys to their suggested-prompt metadata. Only providers
 * listed here produce deterministic "Connect X" prompts when disconnected.
 * The icon values are VIcon case names rendered by the macOS client.
 */
interface PromptEntry {
  label: string;
  prompt: string;
  icon: string;
}

const CONNECT_PROMPT_META: Record<
  string,
  PromptEntry & { connectedPrompts?: PromptEntry[] }
> = {
  google: {
    label: "Connect Gmail",
    prompt: "Help me connect my Gmail account",
    icon: "mail",
    connectedPrompts: [
      {
        label: "Triage my inbox",
        prompt:
          "Help me triage my inbox — summarize what's unread and flag anything that needs a reply",
        icon: "mail",
      },
      {
        label: "Summarize today's emails",
        prompt:
          "Summarize the emails I received today and highlight anything important",
        icon: "mail",
      },
    ],
  },
  slack: {
    label: "Connect Slack",
    prompt: "Help me connect my Slack workspace",
    icon: "hash",
  },
  notion: {
    label: "Connect Notion",
    prompt: "Help me connect my Notion workspace",
    icon: "fileText",
  },
  linear: {
    label: "Connect Linear",
    prompt: "Help me connect my Linear workspace",
    icon: "clipboardList",
  },
  github: {
    label: "Connect GitHub",
    prompt: "Help me connect my GitHub account",
    icon: "terminal",
  },
};

const LLM_SUGGESTIONS_TIMEOUT_MS = 5_000;

/**
 * Produce suggested prompts from both deterministic and LLM sources.
 * Deterministic prompts always come first; LLM-generated prompts are
 * appended when available.
 */
export async function getSuggestedPrompts(): Promise<SuggestedPrompt[]> {
  const prompts: SuggestedPrompt[] = [];

  let deterministicPrompts: SuggestedPrompt[] = [];
  try {
    deterministicPrompts = await getDeterministicPrompts();
    prompts.push(...deterministicPrompts);
  } catch (err) {
    log.warn({ err }, "Failed to compute deterministic suggested prompts");
  }

  try {
    const llmPrompts = await getAssistantGeneratedPrompts(deterministicPrompts);
    prompts.push(...llmPrompts);
  } catch (err) {
    log.warn({ err }, "Failed to generate assistant suggested prompts");
  }

  return prompts;
}

/**
 * Check which well-known OAuth providers are not connected and return
 * a "Connect X" prompt for each. For connected providers that have
 * `connectedPrompts`, return those instead so users discover ongoing
 * management capabilities.
 */
async function getDeterministicPrompts(): Promise<SuggestedPrompt[]> {
  const providers = listProviders();
  const prompts: SuggestedPrompt[] = [];

  for (const provider of providers) {
    const meta = CONNECT_PROMPT_META[provider.provider];
    if (!meta) continue;

    const connected = await isProviderConnected(provider.provider);

    if (!connected) {
      prompts.push({
        id: `connect-${provider.provider}`,
        label: meta.label,
        icon: meta.icon,
        prompt: meta.prompt,
        source: "deterministic",
      });
      continue;
    }

    if (meta.connectedPrompts) {
      for (const cp of meta.connectedPrompts) {
        prompts.push({
          id: `manage-${provider.provider}-${cp.label.toLowerCase().replace(/\s+/g, "-")}`,
          label: cp.label,
          icon: cp.icon,
          prompt: cp.prompt,
          source: "deterministic",
        });
      }
    }
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// LLM-generated suggestions
// ---------------------------------------------------------------------------

interface LLMSuggestion {
  label: string;
  prompt: string;
}

/**
 * Ask the LLM to generate contextual conversation-starter suggestions
 * based on the assistant's persona and the user's connected services.
 * Returns an empty array on failure so deterministic prompts still show.
 */
async function getAssistantGeneratedPrompts(
  deterministicPrompts: SuggestedPrompt[],
): Promise<SuggestedPrompt[]> {
  const config = getConfig();
  const resolved = resolveCallSiteConfig("homeSuggestedPrompts", config.llm);
  const provider = getProvider(resolved.provider);
  const { userPersona, userSlug, channelPersona } = resolvePersonaContext(
    undefined,
    undefined,
  );

  const systemPrompt = buildSystemPrompt({
    excludeBootstrap: true,
    excludeCustomPrefix: true,
    userPersona,
    channelPersona,
    userSlug,
  });

  const existingLabels = deterministicPrompts.map((p) => p.label).join(", ");
  const contextNote = existingLabels
    ? `The user already has these suggestions: ${existingLabels}. Do NOT duplicate them.`
    : "";

  const result = await runBtwSidechain({
    content:
      "Suggest 2-3 short, actionable conversation starters for the home page. " +
      "Each should be something specific and helpful you can do for the user right now. " +
      `${contextNote} ` +
      'Return ONLY a JSON array of objects with "label" (max 5 words) and "prompt" (the full message to send). ' +
      "No markdown fences, no explanation.",
    provider,
    systemPrompt,
    messages: [],
    tools: [],
    callSite: "homeSuggestedPrompts",
    timeoutMs: LLM_SUGGESTIONS_TIMEOUT_MS,
  });

  const text = result.text.trim();
  if (!text) {
    return [];
  }

  const parsed = parseLLMSuggestions(text);
  return parsed.map((s, i) => ({
    id: `assistant-${i}-${s.label.toLowerCase().replace(/\s+/g, "-")}`,
    label: s.label,
    prompt: s.prompt,
    source: "assistant" as const,
  }));
}

function parseLLMSuggestions(text: string): LLMSuggestion[] {
  try {
    const cleaned = text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is LLMSuggestion =>
        typeof item === "object" &&
        item !== null &&
        typeof item.label === "string" &&
        typeof item.prompt === "string",
    );
  } catch {
    log.warn("Failed to parse LLM suggestions response");
    return [];
  }
}
