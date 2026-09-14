/**
 * The hook every attachment surface reads its bytes through: the transcript
 * squares, the user bubble, the tool-result strip, the Chat Info tiles and the
 * full-screen preview. Each of them draws a picture, waits, or falls back on
 * what it settles on, so every one of those answers is pinned here.
 *
 * Driven from the query cache rather than the daemon, since the cache is the
 * seam the five surfaces already share.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { seedQueryFailure } from "@/domains/chat/components/chat-info.test-helper";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  attachmentContentQueryKey,
  useAttachmentObjectUrl,
} from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import type { DisplayAttachment } from "@/types/attachment-types";

type Attachment = Pick<DisplayAttachment, "id" | "previewUrl">;

// happy-dom implements neither half of the object-URL API.
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;
let minted: string[] = [];
let revoked: string[] = [];

globalThis.URL.createObjectURL = (_blob: Blob | MediaSource): string => {
  const url = `blob:attachment-${minted.length}`;
  minted.push(url);
  return url;
};
globalThis.URL.revokeObjectURL = (url: string): void => {
  revoked.push(url);
};

// A request the runner would really send is the one thing a pending fetch must
// not depend on. 404 because it is the one status the fetch helper leaves
// unreported, so a test that lets a request through stays quiet.
const realFetch = daemonClient.getConfig().fetch;
let requests = 0;
const stubFetch: typeof fetch = Object.assign(
  async (): Promise<Response> => {
    requests += 1;
    return new Response(null, { status: 404 });
  },
  { preconnect: () => undefined },
);
daemonClient.setConfig({ fetch: stubFetch });

beforeEach(() => {
  minted = [];
  revoked = [];
  requests = 0;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  daemonClient.setConfig({ fetch: realFetch });
});

function renderObjectUrl(
  attachment: Attachment | null,
  opts: {
    assistantId?: string | null;
    enabled?: boolean;
    seed?: (client: QueryClient) => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  opts.seed?.(client);
  const assistantId: string | null =
    "assistantId" in opts ? (opts.assistantId ?? null) : "asst-1";
  const rendered = renderHook(
    ({ on }: { on: boolean }) =>
      useAttachmentObjectUrl(assistantId, attachment, on),
    {
      initialProps: { on: opts.enabled ?? true },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...rendered, client };
}

const STORED: Attachment = { id: "att-1", previewUrl: null };

describe("useAttachmentObjectUrl", () => {
  test("hands back an inline preview URL without touching the cache", () => {
    const inline = "data:image/png;base64,AAAA";
    const { result, client } = renderObjectUrl({
      id: "att-inline",
      previewUrl: inline,
    });

    expect(result.current.url).toBe(inline);
    expect(result.current.isPending).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(
      client.getQueryState(attachmentContentQueryKey("asst-1", "att-inline"))
        ?.fetchStatus,
    ).toBe("idle");
    expect(requests).toBe(0);
    expect(minted).toEqual([]);
  });

  test("mints an object URL for cached bytes and revokes it on unmount", () => {
    const { result, unmount } = renderObjectUrl(STORED, {
      seed: (client) =>
        client.setQueryData(
          attachmentContentQueryKey("asst-1", "att-1"),
          new Blob(["bytes"]),
        ),
    });

    expect(result.current.url).toBe("blob:attachment-0");
    expect(result.current.isPending).toBe(false);

    unmount();

    expect(revoked).toEqual(["blob:attachment-0"]);
  });

  test("revokes the object URL as soon as the caller stops drawing it", () => {
    const { result, rerender } = renderObjectUrl(STORED, {
      seed: (client) =>
        client.setQueryData(
          attachmentContentQueryKey("asst-1", "att-1"),
          new Blob(["bytes"]),
        ),
    });

    expect(result.current.url).toBe("blob:attachment-0");

    rerender({ on: false });

    expect(revoked).toEqual(["blob:attachment-0"]);
    expect(result.current.url).toBeNull();
  });

  test("serves no URL at all on the first render after the caller switches attachment", () => {
    // The preview gallery walks next and previous under one mounted hook, so
    // the frame the switch renders must not still paint the previous file.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    });
    client.setQueryData(
      attachmentContentQueryKey("asst-1", "att-a"),
      new Blob(["a"]),
    );
    client.setQueryData(
      attachmentContentQueryKey("asst-1", "att-b"),
      new Blob(["b"]),
    );

    const renders: Array<{ url: string | null; isPending: boolean }> = [];
    const { rerender } = renderHook(
      ({ attachment }: { attachment: Attachment }) => {
        const value = useAttachmentObjectUrl("asst-1", attachment, true);
        renders.push({ url: value.url, isPending: value.isPending });
        return value;
      },
      {
        initialProps: {
          attachment: { id: "att-a", previewUrl: null } as Attachment,
        },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );

    expect(renders.at(-1)).toEqual({
      url: "blob:attachment-0",
      isPending: false,
    });
    const firstAfterSwitch = renders.length;

    rerender({ attachment: { id: "att-b", previewUrl: null } });

    expect(renders[firstAfterSwitch]).toEqual({ url: null, isPending: true });
    expect(renders.at(-1)).toEqual({
      url: "blob:attachment-1",
      isPending: false,
    });
    expect(revoked).toEqual(["blob:attachment-0"]);
  });

  test("calls a synthetic history id a legacy one, whose bytes were never kept", () => {
    const { result } = renderObjectUrl({
      id: "rehydrated:2",
      previewUrl: null,
    });

    expect(result.current.legacyId).toBe(true);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.isError).toBe(true);
    expect(result.current.isPending).toBe(false);
  });

  test("calls a real id with no assistant unavailable, not legacy", () => {
    // The composer strip opens the gallery with no assistant behind it. The
    // file still exists; it is only out of this caller's reach.
    const { result } = renderObjectUrl(STORED, { assistantId: null });

    expect(result.current.legacyId).toBe(false);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.isError).toBe(true);
  });

  test("stays pending while the bytes are still on their way", () => {
    const { result } = renderObjectUrl(STORED);

    expect(result.current.isPending).toBe(true);
    expect(result.current.url).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  test("reports a failed fetch as an error the caller can fall back from", () => {
    const { result } = renderObjectUrl(STORED, {
      seed: (client) =>
        seedQueryFailure(
          client,
          attachmentContentQueryKey("asst-1", "att-1"),
          "Failed to load attachment content",
        ),
    });

    expect(result.current.isError).toBe(true);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.isPending).toBe(false);
    expect(result.current.url).toBeNull();
  });

  test("resolves to nothing at all for a caller with no attachment", () => {
    const { result } = renderObjectUrl(null);

    expect(result.current.url).toBeNull();
    expect(result.current.unavailable).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.isPending).toBe(false);
  });
});
