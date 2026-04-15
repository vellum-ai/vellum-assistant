/**
 * Module-level singleton holding the `ConversationAnalysisDeps` bundle.
 *
 * The manual analyze route constructs this dependency bundle once during
 * daemon startup and passes it to `conversationAnalysisRouteDefinitions`.
 * Background callers (e.g. the auto-analyze job handler) don't have access
 * to the HTTP-layer wiring that the route has, so we stash the bundle here
 * so they can invoke `analyzeConversation()` with the same deps.
 *
 * The HTTP route continues to pass deps explicitly; this singleton is purely
 * additive for background callers. Both paths coexist.
 */
import type { ConversationAnalysisDeps } from "./analyze-conversation.js";

let _deps: ConversationAnalysisDeps | null = null;

/**
 * Set the analysis deps bundle. Called once during daemon startup with the
 * same deps the manual analysis route uses, so background jobs can invoke
 * `analyzeConversation()` without HTTP-layer wiring.
 */
export function setAnalysisDeps(deps: ConversationAnalysisDeps): void {
  _deps = deps;
}

/**
 * Returns the deps bundle, or null if the daemon has not finished startup.
 * Callers (e.g. job handlers) should treat null as "skip this job, retry".
 */
export function getAnalysisDeps(): ConversationAnalysisDeps | null {
  return _deps;
}
