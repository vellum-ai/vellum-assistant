import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  clearTranscriptMessages,
  makeAppSummary,
  makeAttachmentSummary,
  makeDocumentSummary,
  reportAssistantVersion,
  seedTranscriptMessages,
} from "@/domains/chat/components/chat-info.test-helper";
import { useConversationAssets } from "@/domains/chat/hooks/use-conversation-assets";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import type { ConversationAssetSource } from "@/lib/conversation-asset-sources";
import { toApiError } from "@/utils/api-errors";

const TARGET = { assistantId: "asst-1", conversationId: "conv-1" };
const SOURCES: ConversationAssetSource[] = [
  "apps",
  "documents",
  "attachments",
  "frames",
];
const originalFetch = globalThis.fetch;
let restoreVersion = () => {};
let queryClient: QueryClient;
let interceptor: number;
let requests: {
  source: ConversationAssetSource;
  offset: number;
  conversation: string;
  assistant: string;
}[];
let responses: Partial<Record<ConversationAssetSource, number>>;
let nextPageStatus = 200;
let totalFrames = 1;
let holdFrames: Promise<void> | null = null;

beforeEach(() => {
  restoreVersion = reportAssistantVersion();
  seedTranscriptMessages(TARGET.assistantId, TARGET.conversationId, []);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retryDelay: 0, staleTime: Infinity, gcTime: Infinity },
    },
  });
  requests = [];
  responses = {};
  nextPageStatus = 200;
  totalFrames = 1;
  holdFrames = null;
  interceptor = daemonClient.interceptors.error.use((error, response) =>
    response && !response.ok ? toApiError(error, response) : error,
  );
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const source = url.pathname.endsWith("/apps")
      ? "apps"
      : url.pathname.endsWith("/documents")
        ? "documents"
        : url.searchParams.get("sightFrames") === "only"
          ? "frames"
          : "attachments";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    requests.push({
      source,
      offset,
      conversation: url.searchParams.get("conversationId") ?? "",
      assistant: url.pathname.split("/")[3]!,
    });
    if (source === "frames" && holdFrames) {
      await holdFrames;
    }
    const status = offset > 0 ? nextPageStatus : (responses[source] ?? 200);
    const data =
      source === "apps"
        ? { apps: [makeAppSummary()] }
        : source === "documents"
          ? { documents: [makeDocumentSummary()] }
          : {
              attachments: [
                makeAttachmentSummary({
                  id: `${source}-${offset}`,
                  sightFrame: source === "frames",
                }),
              ],
              total: source === "frames" ? totalFrames : 1,
              hasMore: source === "frames" && offset === 0 && totalFrames > 1,
            };
    return new Response(
      JSON.stringify(status === 200 ? data : { detail: "Listing unavailable" }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  fetchMock.preconnect = originalFetch.preconnect;
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
  daemonClient.interceptors.error.eject(interceptor);
  restoreVersion();
  clearTranscriptMessages();
});

function mount() {
  return renderHook((target) => useConversationAssets(target), {
    initialProps: TARGET,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

function calls(source: ConversationAssetSource) {
  return requests.filter((request) => request.source === source);
}

describe("asset HTTP failure recovery", () => {
  for (const failed of SOURCES) {
    test(`retains other lists and retries only ${failed}`, async () => {
      responses[failed] = 405;
      const { result } = mount();
      await waitFor(() => expect(result.current.status).toBe("error"));
      await waitFor(() => expect(requests).toHaveLength(4));
      expect(result.current.sources[failed].failure).toBe("load");
      expect(result.current.loadedCount).toBe(3);
      expect(result.current.allFailed).toBe(false);
      expect(result.current.countExact).toBe(false);
      if (failed === "frames") {
        expect(result.current.files.map((file) => file.kind)).toEqual([
          "document",
          "attachment",
        ]);
        expect(result.current.countsExact.files).toBe(true);
      }
      if (failed === "attachments") {
        expect(result.current.frames).toHaveLength(1);
        expect(result.current.files.map((file) => file.kind)).toEqual([
          "document",
        ]);
        expect(result.current.countsExact.frames).toBe(true);
      }
      responses[failed] = 200;
      act(() => {
        result.current.retrySource(failed);
        result.current.retrySource(failed);
      });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.count).toBe(4);
      expect(result.current.countExact).toBe(true);
      for (const source of SOURCES) {
        expect(calls(source)).toHaveLength(source === failed ? 2 : 1);
      }
    });
  }

  test("keeps available files while frames are still loading", async () => {
    let release = () => {};
    holdFrames = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.files).toHaveLength(2));
    expect(result.current.status).toBe("pending");
    expect(result.current.loadedCount).toBe(3);
    expect(result.current.sources.frames.pending).toBe(true);
    expect(result.current.countsExact.files).toBe(true);
    release();
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  test("keeps cached documents visible during a failed refresh and its recovery", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const document = result.current.files[0];
    responses.documents = 500;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() =>
      expect(result.current.sources.documents.failure).toBe("refresh"),
    );
    expect(result.current.files[0]).toEqual(document);
    expect(result.current.countsExact.files).toBe(false);
    responses.documents = 200;
    requests = [];
    act(() => result.current.retryFailedSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(requests.map((request) => request.source)).toEqual(["documents"]);
  });

  test("retains loaded pages and retries the failed offset without refreshing successful pages", async () => {
    totalFrames = 2;
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    nextPageStatus = 500;
    act(() => result.current.loadMoreFrames());
    await waitFor(() =>
      expect(result.current.sources.frames.failure).toBe("page"),
    );
    expect(result.current.frames).toHaveLength(1);
    expect(result.current.files).toHaveLength(2);
    expect(result.current.hasMoreFrames).toBe(true);
    requests = [];
    nextPageStatus = 200;
    act(() => result.current.retryFailedSources());
    await waitFor(() => expect(result.current.frames).toHaveLength(2));
    expect(requests.map(({ source, offset }) => ({ source, offset }))).toEqual([
      { source: "frames", offset: 1 },
    ]);
    expect(result.current.status).toBe("ready");
    expect(result.current.countExact).toBe(true);
  });

  test("retries all four failed sources and clears the full failure state", async () => {
    for (const source of SOURCES) {
      responses[source] = 405;
    }
    const { result } = mount();
    await waitFor(() => expect(result.current.allFailed).toBe(true));
    expect(result.current.loadedCount).toBe(0);
    responses = {};
    act(() => result.current.retryFailedSources());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.allFailed).toBe(false);
    expect(result.current.countExact).toBe(true);
  });

  test("does not carry source errors or data to another conversation or assistant", async () => {
    responses.frames = 405;
    const { result, rerender } = mount();
    await waitFor(() =>
      expect(result.current.sources.frames.failure).toBe("load"),
    );
    responses = {};
    requests = [];
    rerender({ ...TARGET, conversationId: "conv-2" });
    expect(result.current.loadedCount).toBe(0);
    expect(result.current.sources.frames.failure).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(requests.every((request) => request.conversation === "conv-2")).toBe(
      true,
    );
    requests = [];
    rerender({ assistantId: "asst-2", conversationId: "conv-2" });
    expect(result.current.loadedCount).toBe(0);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(requests.every((request) => request.assistant === "asst-2")).toBe(
      true,
    );
  });

  test("uses transcript fallback only for confirmed route absence and qualifies its counts", async () => {
    responses.attachments = 404;
    responses.frames = 404;
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sources.attachments.scope).toBe("loaded-history");
    expect(result.current.sources.frames.supported).toBe(false);
    expect(result.current.countExact).toBe(false);
    expect(result.current.countsExact.frames).toBe(false);
  });
});
