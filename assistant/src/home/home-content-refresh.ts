/**
 * Background refresh timer for LLM-generated home page content.
 *
 * Keeps the personalized greeting and assistant-generated suggestion
 * prompts warm in their caches so the GET handler never triggers LLM
 * calls or database writes (see `src/runtime/AGENTS.md` — GET handler
 * idempotency rule).
 *
 * Call `startHomeContentRefresh()` once during daemon startup; the
 * timer handles periodic re-generation automatically.
 */

import { getLogger } from "../util/logger.js";
import { refreshPersonalizedGreeting } from "./home-greeting.js";
import { refreshAssistantSuggestedPrompts } from "./suggested-prompts.js";

const log = getLogger("home-content-refresh");

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshPersonalizedGreeting(),
    refreshAssistantSuggestedPrompts(),
  ]);
}

/**
 * Start periodic background refresh of home page LLM content.
 * Runs an initial generation immediately (fire-and-forget) and
 * schedules re-generation every 30 minutes.
 */
export function startHomeContentRefresh(): void {
  void refreshAll().catch((err) =>
    log.warn({ err }, "Initial home content refresh failed"),
  );

  refreshTimer = setInterval(() => {
    void refreshAll().catch((err) =>
      log.warn({ err }, "Periodic home content refresh failed"),
    );
  }, REFRESH_INTERVAL_MS);
}

export function stopHomeContentRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
