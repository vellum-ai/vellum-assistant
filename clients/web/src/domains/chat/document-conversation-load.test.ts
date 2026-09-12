import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { waitFor } from "@testing-library/react";

import { publish } from "@/lib/event-bus";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { DocumentContent } from "@/types/document-types";

const original: DocumentContent = {
  success: true,
  surfaceId: "surface-1",
  conversationId: "conv-1",
  title: "Notes",
  content: "Original body",
  wordCount: 2,
  createdAt: 1,
  updatedAt: 1,
};
let document: DocumentContent;
const read = mock(async () => ({ data: { ...document } }));
const conversation = mock(async ({ path }: { path: { id: string } }) => ({
  data: { conversation: { id: path.id } },
  response: new Response(null, { status: 200 }),
}));
const { loadDocumentConversation, documentRequestScope } =
  await import("./document-conversation");

const selection = useResolvedAssistantsStore.getState();
const isCurrent = mock(() => true);
const onReady = mock(
  (_document: DocumentContent, _conversationId: string | null) => {},
);
const options = {
  assistantId: "assistant-1",
  surfaceId: "surface-1",
  isCurrent,
  onReady,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function edit(
  markdown: string,
  mode: "append" | "replace" = "replace",
  surfaceId = "surface-1",
) {
  if (surfaceId === document.surfaceId) {
    document = {
      ...document,
      content: mode === "append" ? document.content + markdown : markdown,
    };
  }
  publish("sse.event", {
    id: "event-1",
    emittedAt: new Date().toISOString(),
    message: {
      type: "document_editor_update",
      conversationId: "conv-1",
      surfaceId,
      markdown,
      mode,
    },
  });
}

function invalidate(tags: string[], originClientId?: string) {
  publish("sse.event", {
    id: "event-sync",
    emittedAt: new Date().toISOString(),
    message: { type: "sync_changed", tags, originClientId },
  });
}

function update(markdown: string, source: "stream" | "sync") {
  if (source === "stream") {
    edit(markdown);
  } else {
    document = { ...document, content: markdown };
    invalidate(["documents:list"], "client-other");
  }
}

beforeEach(() => {
  spyOn(daemonClient, "get").mockImplementation((async (options: {
    url: string;
    path: { id: string };
  }) => {
    if (options.url.endsWith("/documents/{id}")) {
      return read();
    }
    if (options.url.endsWith("/conversations/{id}")) {
      return conversation(options);
    }
    throw new Error(`Unexpected request: ${options.url}`);
  }) as typeof daemonClient.get);
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  document = { ...original };
  read.mockReset();
  read.mockImplementation(async () => ({ data: { ...document } }));
  conversation.mockReset();
  conversation.mockImplementation(async ({ path }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }));
  isCurrent.mockReset();
  isCurrent.mockImplementation(() => true);
  onReady.mockClear();
  window.sessionStorage.clear();
});
afterEach(() => {
  mock.restore();
  useResolvedAssistantsStore.setState(selection, true);
  window.sessionStorage.clear();
});

describe("loadDocumentConversation", () => {
  test("an unchanged load fetches once and releases its update listener", async () => {
    await loadDocumentConversation(options);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(original, "conv-1");
    const checks = isCurrent.mock.calls.length;
    edit("After completion");
    invalidate(["documents:list"]);
    expect(isCurrent).toHaveBeenCalledTimes(checks);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test.each(["surface-1", "surface-other"])(
    "updates during link resolution invalidate only the requested surface: %s",
    async (surfaceId) => {
      const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      edit("Replacement", "replace", surfaceId);
      edit(" plus append", "append", surfaceId);
      pending.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await loading;
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onReady.mock.calls[0]![0].content).toBe(
        surfaceId === "surface-1" ? "Replacement plus append" : "Original body",
      );
      expect(read).toHaveBeenCalledTimes(surfaceId === "surface-1" ? 2 : 1);
    },
  );

  test.each(["stream", "sync"] as const)(
    "%s updates during the document GET invalidate its captured snapshot",
    async (source) => {
      const pending = deferred<{ data: DocumentContent }>();
      read.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      update("Latest body", source);
      pending.resolve({ data: original });
      await loading;
      expect(onReady).toHaveBeenCalledWith(document, "conv-1");
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  test.each(["stream", "sync"] as const)(
    "another %s update during revalidation cannot publish the intermediate body",
    async (source) => {
      const first = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => first.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      update("First revision", source);
      const second = deferred<{ data: DocumentContent }>();
      read.mockImplementationOnce(() => second.promise);
      first.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      const intermediate = { ...document };
      update("First revision plus final revision", source);
      second.resolve({ data: intermediate });
      await loading;
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onReady.mock.calls[0]![0].content).toBe(
        "First revision plus final revision",
      );
      expect(read).toHaveBeenCalledTimes(3);
    },
  );

  test.each(["stream", "sync"] as const)(
    "%s revalidation also validates a changed document conversation",
    async (source) => {
      const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      document = { ...document, conversationId: "conv-2" };
      update("Relinked body", source);
      pending.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await loading;
      expect(onReady).toHaveBeenCalledWith(document, "conv-2");
    },
  );

  test.each(["closed", "assistant switched"])(
    "a %s owner cannot revalidate or publish",
    async (reason) => {
      const scope = documentRequestScope("assistant-1");
      const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation({
        ...options,
        isCurrent: scope.isCurrent,
      });
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      edit("Pending update");
      invalidate(["documents:list"]);
      if (reason === "closed") {
        scope.dispose();
      } else {
        useResolvedAssistantsStore.setState({
          activeAssistantId: "assistant-2",
        });
        useResolvedAssistantsStore.setState({
          activeAssistantId: "assistant-1",
        });
      }
      pending.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await loading;
      scope.dispose();
      expect(read).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();
    },
  );

  test.each(["stream", "sync"] as const)(
    "failed %s revalidation releases its listener and permits a fresh retry",
    async (source) => {
      const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      update("Retain latest server body", source);
      read.mockRejectedValueOnce(new Error("offline"));
      pending.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await expect(loading).rejects.toThrow("offline");
      expect(onReady).not.toHaveBeenCalled();
      const checks = isCurrent.mock.calls.length;
      update("Final server body", source);
      expect(isCurrent).toHaveBeenCalledTimes(checks);
      await loadDocumentConversation(options);
      expect(onReady).toHaveBeenCalledWith(document, "conv-1");
    },
  );

  test.each([undefined, "client-other"])(
    "document invalidations refresh body and title during link resolution (origin: %s)",
    async (originClientId) => {
      const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
      conversation.mockImplementationOnce(() => pending.promise);
      const loading = loadDocumentConversation(options);
      await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
      document = { ...document, title: "Remote title", content: "Remote body" };
      invalidate(["apps:list", "documents:list"], originClientId);
      pending.resolve({
        data: { conversation: { id: "conv-1" } },
        response: new Response(null, { status: 200 }),
      });
      await loading;
      expect(onReady).toHaveBeenCalledWith(document, "conv-1");
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  test("unrelated sync tags do not invalidate a document load", async () => {
    const pending = deferred<Awaited<ReturnType<typeof conversation>>>();
    conversation.mockImplementationOnce(() => pending.promise);
    const loading = loadDocumentConversation(options);
    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));
    invalidate(["apps:list", "conversation:conv-1:messages"]);
    pending.resolve({
      data: { conversation: { id: "conv-1" } },
      response: new Response(null, { status: 200 }),
    });
    await loading;
    expect(onReady).toHaveBeenCalledWith(original, "conv-1");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
