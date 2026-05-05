/**
 * Suggested prompt producer for the Home feed.
 *
 * Returns an array of `SuggestedPrompt` items shown at the top of the
 * Home page as conversation starters (e.g. "Connect Gmail", "Add Slack").
 *
 * Two sources of prompts:
 *   - **Deterministic** — derived from missing OAuth connections.
 *   - **Assistant-generated** — contextual suggestions from the LLM
 *     (placeholder; not yet implemented).
 */

import { isProviderConnected, listProviders } from "../oauth/oauth-store.js";
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

/**
 * Produce deterministic suggested prompts based on missing OAuth
 * connections and (in the future) assistant-generated conversation
 * starters.
 */
export async function getSuggestedPrompts(): Promise<SuggestedPrompt[]> {
  const prompts: SuggestedPrompt[] = [];

  try {
    const deterministicPrompts = await getDeterministicPrompts();
    prompts.push(...deterministicPrompts);
  } catch (err) {
    log.warn({ err }, "Failed to compute deterministic suggested prompts");
  }

  // Placeholder: assistant-generated prompts will be added here once
  // the LLM producer is implemented.

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
