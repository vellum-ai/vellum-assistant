import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import {
  conversationAssetSourceState,
  type ConversationAssetSource,
} from "@/lib/conversation-asset-sources";
import {
  recordLifecycleDiagnostic,
  removeLifecycleDiagnostics,
} from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";

const EVENT_PREFIX = "asset_query_";
const SCOPE_STORAGE_KEY = "vellum:asset-diagnostics-scope:v1";
let activeScope: string | undefined;
const FAILED_QUERIES = new WeakMap<QueryClient, WeakSet<Query>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Classify only conversation asset reads, without retaining raw query keys. */
function assetRequest(queryKey: QueryKey) {
  const key = asRecord(queryKey[0]);
  const path = asRecord(key?.path);
  const params = asRecord(key?.query);
  const assistantId = path?.assistant_id;
  const conversationId = params?.conversationId;
  if (typeof assistantId !== "string" || typeof conversationId !== "string") {
    return null;
  }
  let source: ConversationAssetSource;
  let resource: string;
  switch (key?._id) {
    case "appsGet":
      source = "apps";
      resource = "apps";
      break;
    case "documentsGet":
      source = "documents";
      resource = "documents";
      break;
    case "attachmentsGet":
      if (params?.sightFrames !== "only" && params?.sightFrames !== "exclude") {
        return null;
      }
      source = params.sightFrames === "only" ? "frames" : "attachments";
      resource = "attachments";
      break;
    default:
      return null;
  }
  return {
    source,
    method: "GET" as const,
    endpoint: `/v1/assistants/{assistant_id}/${resource}`,
    assistantId,
    conversationId,
    sightFrames: resource === "attachments" ? params?.sightFrames : null,
    limit: nonNegativeInteger(params?.limit),
    offset: nonNegativeInteger(params?.offset),
    infinite: key?._infinite === true,
  };
}

function describeQuery(query: Query) {
  const request = assetRequest(query.queryKey);
  if (!request) {
    return null;
  }
  const state = query.state;
  const data = asRecord(state.data);
  const pages: unknown[] = Array.isArray(data?.pages) ? data.pages : [];
  const pageParams: unknown[] = Array.isArray(data?.pageParams)
    ? data.pageParams
    : [];
  const fetchingNextPage = state.fetchMeta?.fetchMore?.direction === "forward";
  // A refetch can fail on any loaded page. Its exact offset is unavailable.
  const offset = request.infinite
    ? state.status === "success" && state.fetchStatus === "idle"
      ? nonNegativeInteger(pageParams.at(-1))
      : state.data === undefined
        ? 0
        : fetchingNextPage
          ? pages.reduce<number>((count, page) => {
              const attachments = asRecord(page)?.attachments;
              return (
                count + (Array.isArray(attachments) ? attachments.length : 0)
              );
            }, 0)
          : null
    : request.offset;
  const error = state.error;
  const httpStatus = error instanceof ApiError ? error.status : null;
  const errorCategory = !error
    ? null
    : httpStatus !== null
      ? "http"
      : isTransientNetworkError(error)
        ? "network"
        : error.name === "AbortError"
          ? "cancelled"
          : "unknown";
  return {
    ...request,
    offset,
    loadedPageOffsets: pageParams
      .map(nonNegativeInteger)
      .filter((value) => value !== null),
    status: state.status,
    fetchStatus: state.fetchStatus,
    active: query.getObserversCount() > 0,
    disabled: query.isDisabled(),
    ...conversationAssetSourceState({
      data: state.data,
      isError: state.status === "error",
      error,
      isFetching: state.fetchStatus === "fetching",
      isFetchNextPageError: state.status === "error" && fetchingNextPage,
    }),
    httpStatus,
    errorCategory,
    retryCount: Math.max(0, state.fetchFailureCount - 1),
    dataUpdatedAt: state.dataUpdatedAt || null,
    errorUpdatedAt: state.errorUpdatedAt || null,
  };
}

function bindScope(scopeKey: string): void {
  let previousScope = activeScope;
  if (previousScope === undefined) {
    try {
      previousScope =
        window.sessionStorage.getItem(SCOPE_STORAGE_KEY) ?? undefined;
    } catch {
      // In-memory diagnostics remain available when storage is disabled.
    }
  }
  if (previousScope !== scopeKey) {
    removeLifecycleDiagnostics(EVENT_PREFIX);
  }
  activeScope = scopeKey;
  try {
    window.sessionStorage.setItem(SCOPE_STORAGE_KEY, scopeKey);
  } catch {
    // Scope isolation does not depend on persisting the diagnostic scope.
  }
}

/** One cache subscription per request scope, independent of UI observer count. */
export function installAssetQueryDiagnostics(
  queryClient: QueryClient,
  scopeKey: string,
): () => void {
  bindScope(scopeKey);
  const failed = FAILED_QUERIES.get(queryClient) ?? new WeakSet<Query>();
  FAILED_QUERIES.set(queryClient, failed);
  const record = (query: Query) => {
    try {
      const details = describeQuery(query);
      if (!details || activeScope !== scopeKey) {
        return;
      }
      if (
        query.state.status === "error" &&
        query.state.fetchStatus === "idle"
      ) {
        if (!failed.has(query)) {
          failed.add(query);
          recordLifecycleDiagnostic(`${EVENT_PREFIX}failed`, details);
        }
      } else if (query.state.status === "success" && failed.has(query)) {
        failed.delete(query);
        recordLifecycleDiagnostic(`${EVENT_PREFIX}recovered`, details);
      }
    } catch {
      // Query notifications cannot fail because diagnostic collection failed.
    }
  };
  const cache = queryClient.getQueryCache();
  const unsubscribe = cache.subscribe((event) => {
    if (
      event.type === "updated" &&
      (event.action.type === "error" ||
        (event.action.type === "success" && !event.action.manual))
    ) {
      record(event.query);
    }
  });
  for (const query of cache.getAll()) {
    record(query);
  }
  return unsubscribe;
}

/** Export current cache state using the same allowlist as lifecycle events. */
export function buildAssetDiagnosticsSnapshot(queryClient: QueryClient) {
  const queries = [];
  let unavailable = false;
  try {
    for (const query of queryClient.getQueryCache().getAll()) {
      const details = describeQuery(query);
      if (details) {
        queries.push(details);
      }
    }
  } catch {
    unavailable = true;
  }
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    unavailable,
    queries,
  };
}
