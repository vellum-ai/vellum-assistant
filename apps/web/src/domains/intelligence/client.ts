/**
 * Shared HTTP client configuration for intelligence domain API modules.
 *
 * Re-exports the HeyAPI-generated client, standard error utilities, and the
 * SDK base options constant so each domain module imports from a single
 * location instead of duplicating the setup.
 */

export { client } from "@/generated/api/client.gen";
export {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
  SDK_BASE_OPTIONS,
} from "@/utils/api-errors";
