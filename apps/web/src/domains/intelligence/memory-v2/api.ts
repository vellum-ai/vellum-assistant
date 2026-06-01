/**
 * Fetch wrappers for memory v2 concept-page endpoints.
 *
 * Uses the daemon SDK for routing — all calls go through daemonClient,
 * which forwards unconditionally to the self-hosted gateway.
 *
 * Hand-written types (`./types`) are kept because the generated response
 * types are `200: unknown` for both endpoints.
 */

import {
  memoryV2ConceptpagePost,
  memoryV2ListconceptpagesPost,
} from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import type { ConceptPageSummary, ListConceptPagesResult } from "./types";

export { ApiError };

interface ListConceptPagesResponseBody {
  pages: ConceptPageSummary[];
}

interface ConceptPageResponseBody {
  slug: string;
  rendered: string;
}

/**
 * List all memory v2 concept pages for the assistant.
 *
 * The 3-state result (success / disabled) deliberately omits an `error`
 * branch — transport and server errors throw `ApiError`, letting React
 * Query surface them via `query.isError` instead of caching a sentinel
 * payload as a successful response. The 409 `MEMORY_V2_DISABLED` envelope
 * collapses to `{ kind: "disabled" }` so the panel can render the
 * intentional-off empty state without retry churn.
 */
export async function listConceptPages(
  assistantId: string,
): Promise<ListConceptPagesResult> {
  const { data, error, response } = await memoryV2ListconceptpagesPost({
    path: { assistant_id: assistantId },
    body: {},
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to load concept pages.");

  if (response.status === 409) {
    const errObj = error as Record<string, unknown> | undefined;
    const nested = errObj?.error as Record<string, unknown> | undefined;
    if (nested?.code === "MEMORY_V2_DISABLED") {
      return { kind: "disabled" };
    }
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load concept pages."),
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load concept pages."),
    );
  }

  const body = data as ListConceptPagesResponseBody | undefined;
  return { kind: "success", pages: body?.pages ?? [] };
}

export async function readConceptPage(
  assistantId: string,
  slug: string,
): Promise<string | null> {
  const { data, error, response } = await memoryV2ConceptpagePost({
    path: { assistant_id: assistantId },
    body: { slug },
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to load concept page.");

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load concept page."),
    );
  }

  const body = data as ConceptPageResponseBody | undefined;
  return body?.rendered ?? null;
}
