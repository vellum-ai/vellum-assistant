/**
 * URL classifier for self-hosted assistant request routing.
 *
 * Most per-assistant routes (`/v1/assistants/{id}/conversations/...`,
 * `/v1/assistants/{id}/messages/...`, etc.) are runtime-proxied by the
 * platform — Django's `RuntimeProxyView` forwards them to the assistant
 * pod via vembda. For self-hosted assistants, the platform's proxy view
 * filters those out of its queryset, so we have to call the user's
 * gateway directly.
 *
 * A small set of management actions (`activate`, `resize`, `hatch`,
 * `retire`, `restart`, `backups`, etc.) are owned by the platform and
 * must NOT be re-routed — they operate on the platform's record of the
 * assistant, not on the runtime.
 *
 * `classifyAssistantPath` answers the single question the interceptor
 * cares about: should this path go to the platform or to the self-hosted
 * ingress?
 *
 * The platform-action list mirrors the `@action(detail=True, …)`
 * decorators on `AssistantViewSet` in
 * `vellum-assistant-platform/django/app/assistant/views.py`, plus the
 * `<uuid:assistant_id>/backups/...` URL conf entry in
 * `assistant/urls.py`. Keep them in sync — adding a new platform-only
 * detail action requires a matching entry here.
 */

/**
 * First path segments after `/v1/assistants/{id}/` that stay on the
 * platform even when the assistant is registered self-hosted.
 */
const PLATFORM_ACTION_SEGMENTS = new Set<string>([
  // Lifecycle / capacity
  "activate",
  "resize",
  "restart",
  "retire",
  // Upgrade / rollback
  "upgrade",
  "upgrade-status",
  "upgrade-policy",
  "rollback",
  // Policy + consent
  "sleep-policy",
  "access-consent",
  // Activity + reachability
  "record-activity",
  "connection-status",
  // Snapshots
  "backups",
]);

const ASSISTANT_PATH_RE =
  /^\/v1\/assistants\/([^/]+)(?:\/([^/?#]*))?(?:\/.*)?$/;

export interface AssistantPathInfo {
  /** Assistant id parsed from the URL, or `null` if the path didn't match. */
  assistantId: string | null;
  /**
   * Whether this path is a per-assistant runtime-proxied route. Only
   * `true` when the path is `/v1/assistants/{id}/<subpath>` and
   * `<subpath>`'s first segment is not in {@link PLATFORM_ACTION_SEGMENTS}.
   */
  isRuntimeProxied: boolean;
}

export function classifyAssistantPath(pathname: string): AssistantPathInfo {
  const m = ASSISTANT_PATH_RE.exec(pathname);
  if (!m) {
    return { assistantId: null, isRuntimeProxied: false };
  }
  const assistantId = m[1] ?? null;
  const firstSegment = m[2] ?? "";
  if (firstSegment === "") {
    // Bare `/v1/assistants/{id}/` — the canonical retrieve. Platform-owned.
    return { assistantId, isRuntimeProxied: false };
  }
  if (PLATFORM_ACTION_SEGMENTS.has(firstSegment)) {
    return { assistantId, isRuntimeProxied: false };
  }
  return { assistantId, isRuntimeProxied: true };
}
