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

export { client } from "@/generated/api/client.gen";
export {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors";

export const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);
