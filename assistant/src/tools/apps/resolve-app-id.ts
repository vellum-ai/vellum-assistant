import { listAppsByConversation } from "../../apps/app-store.js";

/**
 * Resolve the `app_id` an app-builder tool should operate on.
 *
 * Weaker models routinely omit `app_id` when calling `app_*` tools through
 * `skill_execute`, even though the active app's id is in their context from the
 * preceding `app_create`/`app_update` result. Left unhandled, the executor
 * fails with a cryptic "Invalid ID: undefined", the model retries the same
 * empty call, and the turn burns many steps before recovering.
 *
 * An explicit, non-empty `app_id` always wins. When it is missing, fall back to
 * the conversation's most-recently-updated app — the one being actively built.
 * Returns `null` when no app_id is supplied and the conversation has no app, so
 * callers can surface an actionable error instead of a raw store throw.
 *
 * Not used for destructive operations (`app_delete`): deleting an inferred app
 * is unsafe, so deletion requires an explicit id.
 */
export function resolveAppId(
  input: Record<string, unknown>,
  conversationId: string,
): string | null {
  if (typeof input.app_id === "string" && input.app_id.trim().length > 0) {
    return input.app_id;
  }
  // `listAppsByConversation` preserves `listApps`' updatedAt-descending order,
  // so the first entry is the app the model is actively working on.
  const apps = listAppsByConversation(conversationId);
  return apps.length > 0 ? apps[0].id : null;
}

/** Error payload returned when no app_id is supplied and none can be inferred. */
export function missingAppIdError(): { content: string; isError: boolean } {
  return {
    content: JSON.stringify({
      error:
        "app_id is required and no active app exists in this conversation. Call app_create first, or pass app_id explicitly.",
    }),
    isError: true,
  };
}
