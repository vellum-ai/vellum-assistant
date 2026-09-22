import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";

import {
  appsGetQueryKey,
  attachmentsGetInfiniteQueryKey,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  buildAssetDiagnosticsSnapshot,
  installAssetQueryDiagnostics,
} from "@/lib/asset-query-diagnostics";
import {
  getLifecycleDiagnosticsEvents,
  recordDiagnostic,
  recordLifecycleDiagnostic,
  removeLifecycleDiagnostics,
} from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";

const ARGS = {
  path: { assistant_id: "assistant-123" },
  query: { conversationId: "conv-123" },
};
const FILES_KEY = attachmentsGetInfiniteQueryKey({
  ...ARGS,
  query: { ...ARGS.query, sightFrames: "exclude", limit: 200 },
});
const FRAMES_KEY = attachmentsGetInfiniteQueryKey({
  ...ARGS,
  query: { ...ARGS.query, sightFrames: "only", limit: 200 },
});

let client: QueryClient;
let unsubscribers: Array<() => void>;
const assetEvents = () =>
  getLifecycleDiagnosticsEvents().filter((event) =>
    event.kind.startsWith("asset_query_"),
  );

beforeEach(() => {
  removeLifecycleDiagnostics("asset_query_");
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  unsubscribers = [installAssetQueryDiagnostics(client, "user-123:org-abc")];
});

afterEach(() => {
  for (const unsubscribe of unsubscribers) {
    unsubscribe();
  }
  client.clear();
});

describe("asset query diagnostics", () => {
  test("records a terminal 405 alongside healthy app and document lists", async () => {
    await client.fetchQuery({
      queryKey: appsGetQueryKey(ARGS),
      queryFn: async () => ({ apps: [] }),
    });
    await client.fetchQuery({
      queryKey: documentsGetQueryKey(ARGS),
      queryFn: async () => ({ documents: [] }),
    });
    await expect(
      client.fetchInfiniteQuery({
        queryKey: FILES_KEY,
        initialPageParam: 0,
        queryFn: async () => {
          throw new ApiError(405, "Method not allowed");
        },
      }),
    ).rejects.toThrow();

    expect(assetEvents()).toHaveLength(1);
    expect(assetEvents()[0]!.details).toMatchObject({
      source: "attachments",
      method: "GET",
      endpoint: "/v1/assistants/{assistant_id}/attachments",
      assistantId: "assistant-123",
      conversationId: "conv-123",
      sightFrames: "exclude",
      limit: 200,
      offset: 0,
      httpStatus: 405,
      errorCategory: "http",
      hasData: false,
      failure: "load",
      retryCount: 0,
    });
    const snapshot = buildAssetDiagnosticsSnapshot(client);
    expect(snapshot.unavailable).toBe(false);
    expect(
      snapshot.queries.map((query) => [query.source, query.status]),
    ).toEqual([
      ["apps", "success"],
      ["documents", "success"],
      ["attachments", "error"],
    ]);
  });

  test("waits for retries to finish, records network failures without a status, and recovers", async () => {
    let attempts = 0;
    await expect(
      client.fetchQuery({
        queryKey: FRAMES_KEY,
        retry: 2,
        retryDelay: 0,
        queryFn: async () => {
          expect(assetEvents()).toHaveLength(0);
          attempts += 1;
          throw new TypeError("Failed to fetch");
        },
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
    expect(assetEvents()[0]!.details).toMatchObject({
      source: "frames",
      httpStatus: null,
      errorCategory: "network",
      retryCount: 2,
    });
    await client.fetchQuery({
      queryKey: FRAMES_KEY,
      queryFn: async () => ({ pages: [], pageParams: [] }),
    });
    expect(assetEvents().map((event) => event.kind)).toEqual([
      "asset_query_failed",
      "asset_query_recovered",
    ]);
    expect(buildAssetDiagnosticsSnapshot(client).queries[0]).toMatchObject({
      failure: null,
      hasData: true,
      status: "success",
    });
  });

  test("keeps cached data on refresh failure and does not treat manual data writes as recovery", async () => {
    const queryKey = documentsGetQueryKey(ARGS);
    await client.fetchQuery({
      queryKey,
      queryFn: async () => ({ documents: [{ title: "private document" }] }),
    });
    await expect(
      client.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw new ApiError(503, "Private response body");
        },
      }),
    ).rejects.toThrow();
    expect(assetEvents()[0]!.details).toMatchObject({
      hasData: true,
      failure: "refresh",
      httpStatus: 503,
    });
    client.setQueryData(queryKey, { documents: [] });
    expect(assetEvents()).toHaveLength(1);
    await client.fetchQuery({
      queryKey,
      queryFn: async () => ({ documents: [] }),
    });
    expect(assetEvents()[1]!.kind).toBe("asset_query_recovered");
  });

  test("multiple observers and subscription remounts do not duplicate terminal failures", async () => {
    const options = {
      queryKey: appsGetQueryKey(ARGS),
      queryFn: async () => {
        throw new ApiError(405, "No list");
      },
      retry: false as const,
    };
    const first = new QueryObserver(client, options);
    const second = new QueryObserver(client, options);
    unsubscribers.push(
      first.subscribe(() => {}),
      second.subscribe(() => {}),
    );
    await expect(client.fetchQuery(options)).rejects.toThrow();
    expect(assetEvents()).toHaveLength(1);
    unsubscribers[0]!();
    unsubscribers.push(
      installAssetQueryDiagnostics(client, "user-123:org-abc"),
    );
    expect(assetEvents()).toHaveLength(1);
  });

  test("identifies failed next-page offsets without inventing the failed offset during a refetch", async () => {
    let failAt: number | null = 2;
    const observer = new InfiniteQueryObserver<{
      attachments: unknown[];
      hasMore: boolean;
    }>(client, {
      queryKey: FILES_KEY,
      initialPageParam: 0,
      getNextPageParam: (lastPage) => (lastPage.hasMore ? 2 : undefined),
      queryFn: async ({ pageParam }) => {
        if (pageParam === failAt) {
          throw new ApiError(503, "Unavailable");
        }
        return {
          attachments: pageParam === 0 ? [{}, {}] : [{}],
          hasMore: pageParam === 0,
        };
      },
    });
    unsubscribers.push(observer.subscribe(() => {}));
    await observer.refetch({ throwOnError: true });
    await expect(
      observer.fetchNextPage({ throwOnError: true }),
    ).rejects.toThrow();
    expect(assetEvents()[0]!.details).toMatchObject({
      failure: "page",
      offset: 2,
      hasData: true,
      loadedPageOffsets: [0],
    });

    failAt = null;
    await observer.fetchNextPage({ throwOnError: true });
    expect(assetEvents()[1]!.kind).toBe("asset_query_recovered");
    expect(assetEvents()[1]!.details.offset).toBe(2);
    failAt = 2;
    await expect(observer.refetch({ throwOnError: true })).rejects.toThrow();
    expect(buildAssetDiagnosticsSnapshot(client).queries[0]).toMatchObject({
      failure: "refresh",
      offset: null,
      loadedPageOffsets: [0, 2],
    });
  });

  test("scope changes discard asset events and cannot record late responses from the prior scope", async () => {
    recordLifecycleDiagnostic("unrelated_lifecycle_event");
    await expect(
      client.fetchQuery({
        queryKey: FILES_KEY,
        queryFn: async () => {
          throw new ApiError(405, "No list");
        },
      }),
    ).rejects.toThrow();
    let rejectOldRequest: (error: Error) => void = () => {};
    const oldRequest = client.fetchQuery({
      queryKey: FRAMES_KEY,
      queryFn: () =>
        new Promise<never>((_resolve, reject) => {
          rejectOldRequest = reject;
        }),
    });
    const nextClient = new QueryClient();
    unsubscribers.push(
      installAssetQueryDiagnostics(nextClient, "user-456:org-xyz"),
    );
    rejectOldRequest(new ApiError(405, "Late old-scope failure"));
    await expect(oldRequest).rejects.toThrow();
    expect(assetEvents()).toHaveLength(0);
    expect(buildAssetDiagnosticsSnapshot(nextClient).queries).toHaveLength(0);
    expect(
      getLifecycleDiagnosticsEvents().some(
        (event) => event.kind === "unrelated_lifecycle_event",
      ),
    ).toBe(true);
    nextClient.clear();
  });

  test("bounded lifecycle retention survives streaming and the current failure remains in the snapshot", async () => {
    await expect(
      client.fetchQuery({
        queryKey: FILES_KEY,
        queryFn: async () => {
          throw new ApiError(405, "No list");
        },
      }),
    ).rejects.toThrow();
    for (let index = 0; index < 250; index += 1) {
      recordDiagnostic("stream_delta", { index });
    }
    expect(assetEvents()).toHaveLength(1);
    for (let index = 0; index < 250; index += 1) {
      recordLifecycleDiagnostic("connection_transition", { index });
    }
    expect(getLifecycleDiagnosticsEvents()).toHaveLength(200);
    expect(assetEvents()).toHaveLength(0);
    expect(buildAssetDiagnosticsSnapshot(client).queries[0]?.httpStatus).toBe(
      405,
    );
  });

  test("exports only allowlisted request and state fields", async () => {
    const queryKey = [
      {
        ...FILES_KEY[0],
        baseUrl: "https://private.example.com",
        headers: { Authorization: "secret-token" },
        body: { content: "private-body" },
        query: { ...FILES_KEY[0].query, extra: "private-param" },
      },
    ];
    client.setQueryData(queryKey, {
      pages: [
        {
          attachments: [
            { filename: "private-name.png", data: "private-bytes" },
          ],
        },
      ],
      pageParams: [0],
    });
    await expect(
      client.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw new ApiError(405, "secret-error", {
            details: { secret: "private-error-body" },
          });
        },
      }),
    ).rejects.toThrow();
    const serialized = JSON.stringify({
      snapshot: buildAssetDiagnosticsSnapshot(client),
      events: assetEvents(),
    });
    for (const forbidden of [
      "private.example.com",
      "Authorization",
      "secret-token",
      "private-body",
      "private-param",
      "private-name.png",
      "private-bytes",
      "secret-error",
      "private-error-body",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(
      buildAssetDiagnosticsSnapshot(client).queries[0]?.loadedPageOffsets,
    ).toEqual([0]);
  });

  test("ignores non-conversation reads and remains best-effort for malformed keys", () => {
    client.setQueryData(appsGetQueryKey({ path: ARGS.path }), { apps: [] });
    client.setQueryData(["other-cache"], { secret: "private" });
    expect(buildAssetDiagnosticsSnapshot(client).queries).toHaveLength(0);
  });
});
