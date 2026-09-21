import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";

import { toast } from "@vellumai/design-library";

import { useNewLibraryDocument } from "./use-new-library-document";

let createDocumentFails = false;
let toastError: ReturnType<typeof spyOn>;
let post: ReturnType<typeof spyOn>;
let del: ReturnType<typeof spyOn>;
let queryClient: QueryClient;

function Wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function okResponse(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) };
}

beforeEach(() => {
  queryClient = new QueryClient();
  createDocumentFails = false;
  toastError = spyOn(toast, "error").mockImplementation(
    (() => "") as unknown as typeof toast.error,
  );
  post = spyOn(daemonClient, "post").mockImplementation((async (options: {
    url: string;
  }) => {
    if (options.url.endsWith("/conversations")) {
      return okResponse({ id: "conv-new" });
    }
    if (options.url.endsWith("/documents/create")) {
      if (createDocumentFails) {
        throw new Error("boom");
      }
      return okResponse({ surfaceId: "doc-new" });
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as unknown as typeof daemonClient.post);
  del = spyOn(daemonClient, "delete").mockImplementation((async () =>
    okResponse({})) as unknown as typeof daemonClient.delete);
});

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("useNewLibraryDocument", () => {
  test("starts a conversation, creates the document in it, and opens it", async () => {
    const onCreated = mock(() => {});
    const { result } = renderHook(
      () => useNewLibraryDocument("assistant-1", onCreated),
      { wrapper: Wrapper },
    );

    await act(() => result.current.newDocument());

    const urls = (post.mock.calls as [{ url: string }][]).map(
      ([options]) => options.url,
    );
    expect(urls).toEqual([
      "/v1/assistants/{assistant_id}/conversations",
      "/v1/assistants/{assistant_id}/documents/create",
    ]);
    expect(post.mock.calls[1][0]).toMatchObject({
      body: { conversationId: "conv-new" },
    });
    expect(onCreated).toHaveBeenCalledWith("doc-new");
    expect(result.current.isCreating).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  test("a failed document create gives the conversation back and tells the user", async () => {
    createDocumentFails = true;
    const onCreated = mock(() => {});
    const { result } = renderHook(
      () => useNewLibraryDocument("assistant-1", onCreated),
      { wrapper: Wrapper },
    );

    await act(() => result.current.newDocument());

    expect(onCreated).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toMatchObject({
      path: { assistant_id: "assistant-1", id: "conv-new" },
    });
  });
});
