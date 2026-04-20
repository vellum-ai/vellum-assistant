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
 * The icon values are SF Symbol names rendered by the macOS client.
 */
const CONNECT_PROMPT_META: Record<
  string,
  { label: string; prompt: string; icon: string }
> = {
  google: {
    label: "Connect Gmail",
    prompt: "Help me connect my Gmail account",
    icon: "mail",
  },
  slack: {
    label: "Connect Slack",
    prompt: "Help me connect my Slack workspace",
    icon: "number",
  },
  calendar: {
    label: "Connect Calendar",
    prompt: "Help me connect my Google Calendar",
    icon: "calendar",
  },
  notion: {
    label: "Connect Notion",
    prompt: "Help me connect my Notion workspace",
    icon: "doc.text",
  },
  linear: {
    label: "Connect Linear",
    prompt: "Help me connect my Linear workspace",
    icon: "list.bullet",
  },
  github: {
    label: "Connect GitHub",
    prompt: "Help me connect my GitHub account",
    icon: "chevron.left.forwardslash.chevron.right",
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
 * a "Connect X" prompt for each.
 */
async function getDeterministicPrompts(): Promise<SuggestedPrompt[]> {
  const providers = listProviders();
  const prompts: SuggestedPrompt[] = [];

  for (const provider of providers) {
    const meta = CONNECT_PROMPT_META[provider.provider];
    if (!meta) continue;

    const connected = await isProviderConnected(provider.provider);
    if (connected) continue;

    prompts.push({
      id: `connect-${provider.provider}`,
      label: meta.label,
      icon: meta.icon,
      prompt: meta.prompt,
      source: "deterministic",
    });
  }

  return prompts;
}
