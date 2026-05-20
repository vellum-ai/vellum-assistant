/**
 * Personalized home-page greeting generator.
 *
 * Produces a short greeting in the assistant's tone/persona for the
 * Home page header. Uses the BTW side-chain for LLM generation and
 * caches the result for 4 hours (busted when identity files change).
 *
 * Falls back to a generic time-of-day greeting when the LLM call
 * fails or when no provider is available.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { resolvePersonaContext } from "../prompts/persona-resolver.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { getProvider } from "../providers/registry.js";
import { runBtwSidechain } from "../runtime/btw-sidechain.js";
import { getLogger } from "../util/logger.js";
import {
  getCachedHomeGreeting,
  setCachedHomeGreeting,
} from "./home-greeting-cache.js";

const log = getLogger("home-greeting");

const GENERATION_TIMEOUT_MS = 5_000;

/**
 * Return a personalized greeting if cached or generatable within the
 * timeout. Falls back to `null` so the caller can use the generic
 * time-of-day greeting.
 */
export async function getPersonalizedGreeting(): Promise<string | null> {
  const cached = getCachedHomeGreeting();
  if (cached) {
    return cached;
  }

  try {
    const config = getConfig();
    const resolved = resolveCallSiteConfig("homeGreeting", config.llm);
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
      timeoutMs: GENERATION_TIMEOUT_MS,
    });

    const text = result.text.trim();
    if (text) {
      setCachedHomeGreeting(text);
      return text;
    }
  } catch (err) {
    log.warn({ err }, "Failed to generate personalized home greeting");
  }

  return null;
}
