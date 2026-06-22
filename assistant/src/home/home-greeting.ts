/**
 * Personalized home-page greeting generator.
 *
 * Produces a short greeting in the assistant's tone/persona for the
 * Home page header. Uses the BTW side-chain for LLM generation and
 * caches the result for 4 hours (busted when identity files change).
 *
 * The GET handler reads only from cache (`getPersonalizedGreeting`).
 * Generation runs on demand via `refreshPersonalizedGreeting`, invoked
 * fire-and-forget by the home-content revalidation coordinator when a
 * client fetches the home feed and the cache is stale (see
 * `home-content-refresh.ts`). Nothing generates at daemon startup or on
 * a timer — LLM cost is only incurred when a user actually views Home.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
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
 * No-ops when the cache is still fresh. Intended for fire-and-forget
 * background invocation, not the GET path. Returns `true` when a new
 * greeting was generated and cached.
 */
export async function refreshPersonalizedGreeting(): Promise<boolean> {
  const cached = getCachedHomeGreeting();
  if (cached) {
    return false;
  }

  try {
    const config = getConfig();
    const resolved = resolveCallSiteConfig("homeGreeting", config.llm);

    const provider = await getConfiguredProvider("homeGreeting");
    if (!provider) {
      return false;
    }

    const systemPrompt = buildSystemPrompt({
      excludeBootstrap: true,
      excludeCustomPrefix: true,
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
      return setCachedHomeGreeting(text);
    }
  } catch (err) {
    log.warn({ err }, "Failed to generate personalized home greeting");
  }
  return false;
}
