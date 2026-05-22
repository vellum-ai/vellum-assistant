/**
 * Shared HTTP client configuration for chat API domain modules.
 *
 * Re-exports the HeyAPI-generated client, standard error utilities, and the
 * SDK base options constant so each domain module imports from a single
 * location instead of duplicating the setup.
 */

// Side-effect import to configure the default HeyAPI client.
// We're using the raw `fetch` client here for legacy reasons.
// You should typically use the tanstack-query provider which ensures the client is configured.

export { client } from "@/generated/api/client.gen.js";
export {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors.js";

export const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

/**
 * Build the query-param object for daemon endpoints that accept a
 * conversation identifier. Sends `conversationId` (UUID, resolves
 * against the `conversations` table on all DB versions) as the primary
 * key. Includes `conversationKey` as a fallback for handlers that
 * haven't been updated to accept `conversationId` yet.
 *
 * Prefer this over manually writing `{ conversationId }` or
 * `{ conversationId, conversationKey }` — it keeps the wire format
 * in one place so fallback params can be dropped globally when all
 * daemon handlers accept `conversationId`.
 */
export function conversationQueryParams(conversationId: string): {
  conversationId: string;
  conversationKey: string;
} {
  return { conversationId, conversationKey: conversationId };
}
