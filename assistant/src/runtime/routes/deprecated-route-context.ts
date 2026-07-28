/**
 * Deprecated `/x/*` route context — a telemetry-emitting compatibility shim.
 *
 * Route handlers now reach daemon capabilities through `@vellumai/plugin-api`
 * (`publishEvent`, `runConversationTurn`), which work identically in-process and
 * in the route-host subprocess. Installed route files written against the older
 * `(request, context)` signature keep working: each `context` field delegates
 * to its plugin-api equivalent and records a deprecation-usage telemetry signal
 * the first time a given route touches it, so usage can be watched down to zero
 * before the argument is removed.
 *
 * This whole module — and the handler's second parameter — is intended to be
 * deleted once the telemetry shows no route still depends on `context`.
 *
 * Telemetry: emitted daemon-side via the generic `watchdog` event (the
 * sanctioned named-label + open-`detail`-bag carrier, as `memory_tier` uses),
 * so it ships without a new platform wire type. `check_name` is
 * `"deprecated_api_use"`; `detail` carries `{ surface, api, replacement,
 * route_path }`. A dedicated first-class `deprecation` wire event is proposed to
 * platform; when it lands, swap the emit here to it and freeze.
 */

import { runConversationTurn } from "../../plugin-api/conversation-turn.js";
import { publishEvent } from "../../plugin-api/publish-event.js";
import { recordWatchdogEvent } from "../../telemetry/watchdog-events-store.js";

/**
 * The deprecated second argument passed to `/x/*` route handlers. Every member
 * is a thin shim over `@vellumai/plugin-api`; prefer importing from there
 * directly in new handlers.
 */
export interface UserRouteContext {
  /**
   * @deprecated Import `publishEvent` from `@vellumai/plugin-api` instead.
   * `publish` forwards to it verbatim.
   */
  readonly assistantEventHub: { publish: typeof publishEvent };
  /**
   * @deprecated Import `runConversationTurn` from `@vellumai/plugin-api`
   * instead. `postMessage` runs a turn with the text as a single content block.
   */
  readonly conversations: {
    postMessage(
      conversationId: string,
      text: string,
    ): Promise<{ messageId: string }>;
  };
}

/** Stable `watchdog` label for a deprecated-API-use signal. Frozen once shipped — dashboards pivot on it. */
const DEPRECATED_API_CHECK_NAME = "deprecated_api_use";

/** Separator for dedup keys. `api` is a fixed `context.*` string, so `::` cannot make two distinct (route, api) pairs collide. */
const KEY_SEPARATOR = "::";

/**
 * Fired-once keys (`route_path <sep> api`) so a route in a hot loop records one
 * signal per deprecated field per process rather than one per call. We only
 * need to learn *which* route depends on *which* field, not the call count.
 */
const reportedUses = new Set<string>();

function recordDeprecatedUse(
  routePath: string,
  api: string,
  replacement: string,
): void {
  const key = `${routePath}${KEY_SEPARATOR}${api}`;
  if (reportedUses.has(key)) {
    return;
  }
  reportedUses.add(key);
  recordWatchdogEvent({
    checkName: DEPRECATED_API_CHECK_NAME,
    detail: {
      surface: "custom_route",
      api,
      replacement,
      route_path: routePath,
    },
  });
}

/**
 * Build the deprecated `context` argument for a handler serving `routePath`.
 * The route path is captured so a use signal can be attributed to the specific
 * route that must migrate. The object is frozen so a handler cannot corrupt the
 * shared shim by reassigning its members.
 */
export function buildDeprecatedRouteContext(
  routePath: string,
): UserRouteContext {
  return Object.freeze({
    assistantEventHub: Object.freeze({
      publish: (
        event: Parameters<typeof publishEvent>[0],
        options?: Parameters<typeof publishEvent>[1],
      ): ReturnType<typeof publishEvent> => {
        recordDeprecatedUse(
          routePath,
          "context.assistantEventHub.publish",
          "plugin-api:publishEvent",
        );
        return publishEvent(event, options);
      },
    }),
    conversations: Object.freeze({
      postMessage: async (
        conversationId: string,
        text: string,
      ): Promise<{ messageId: string }> => {
        recordDeprecatedUse(
          routePath,
          "context.conversations.postMessage",
          "plugin-api:runConversationTurn",
        );
        const { userMessageId } = await runConversationTurn({
          conversationId,
          content: [{ type: "text", text }],
        });
        return { messageId: userMessageId };
      },
    }),
  });
}
