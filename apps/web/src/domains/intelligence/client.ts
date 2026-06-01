/**
 * Shared HTTP client configuration for intelligence domain API modules.
 *
 * Re-exports the HeyAPI-generated client and standard error utilities so each
 * domain module imports from a single location instead of duplicating the
 * setup.
 */

export { client } from "@/generated/api/client.gen";
export {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
