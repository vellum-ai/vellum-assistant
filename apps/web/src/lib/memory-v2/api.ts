// Hand-written fetch wrappers — these endpoints are served by the assistant
// daemon via RuntimeProxyWildcardView and are not in the Django OpenAPI schema.
import { client } from "@/generated/api/client.gen.js";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/lib/api/errors.js";
import "@/lib/vellum-api/client.js";
import type { ConceptPageSummary, ListConceptPagesResult } from "@/lib/memory-v2/types.js";

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

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
  const { data, error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/memory/v2/list-concept-pages",
    path: { assistant_id: assistantId },
    body: {},
    headers: { "Content-Type": "application/json" },
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
  const { data, error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/memory/v2/concept-page",
    path: { assistant_id: assistantId },
    body: { slug },
    headers: { "Content-Type": "application/json" },
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
