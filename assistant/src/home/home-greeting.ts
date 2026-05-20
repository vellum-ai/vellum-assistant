/**
 * Personalized home-page greeting generator.
 *
 * Produces a short greeting in the assistant's tone/persona for the
 * Home page header. Uses the BTW side-chain for LLM generation and
 * caches the result for 4 hours (busted when identity files change).
 *
 * The GET handler reads only from cache (`getPersonalizedGreeting`).
 * Generation runs in the background via `refreshPersonalizedGreeting`,
 * called at daemon startup and periodically by the home-content
 * refresh timer.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { resolvePersonaContext } from "../prompts/persona-resolver.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import {
  getCachedHomeGreeting,
  setCachedHomeGreeting,
} from "./home-greeting-cache.js";

const log = getLogger("home-greeting");

const GENERATION_TIMEOUT_MS = 5_000;

/**
 * Return the cached personalized greeting, or `null` when none is
 * available yet. This is a synchronous cache read — safe for GET
 * handlers.
 */
export function getPersonalizedGreeting(): string | null {
  return getCachedHomeGreeting();
}

/**
 * Generate a personalized greeting via LLM and write it to cache.
 * No-ops when the cache is still fresh. Intended for background
 * invocation (daemon startup / periodic refresh), not the GET path.
 */
export async function refreshPersonalizedGreeting(): Promise<void> {
  const cached = getCachedHomeGreeting();
  if (cached) {
    return;
  }

  try {
    const config = getConfig();
    const resolved = resolveCallSiteConfig("homeGreeting", config.llm);

    const provider = await getConfiguredProvider("homeGreeting");
    if (!provider) {
      return;
    }

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

    const result = await runBtwSidechain({
      content:
        "Generate a short, casual greeting for the home page (max 10 words). " +
        "It should convey the meaning of 'here's what's been going on' but in " +
        "your unique tone and personality. Just output the greeting text, nothing else. " +
        "No quotes, no preamble.",
      provider,
      systemPrompt,
      messages: [],
      tools: [],
      callSite: "homeGreeting",
      maxTokens: resolved.maxTokens,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

    const text = result.text.trim();
    if (text) {
      setCachedHomeGreeting(text);
    }
  } catch (err) {
    log.warn({ err }, "Failed to generate personalized home greeting");
  }
}
