import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sdk = await import("@/generated/daemon/sdk.gen");
const getConversation = mock(async (_options: { path: { id: string } }) => ({
  data: { conversation: { id: "conv-existing" } },
  response: new Response(null, { status: 200 }),
}));
const createConversation = mock(
  async (_options: { body: { conversationKey: string } }) => ({
    data: { id: "conv-created" },
  }),
);
const linkConversation = mock(
  async (_options: { body: { conversationId: string } }) => ({}),
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdk,
  conversationsByIdGet: getConversation,
  conversationsPost: createConversation,
  documentsByIdConversationsPost: linkConversation,
}));

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";
const {
  documentRequestScope,
  resolveDocumentConversation,
  startDocumentConversation,
} = await import("./document-conversation");

const document = { surfaceId: "surface-1", conversationId: "conv-existing" };
const options = { assistantId: "assistant-1", document, isCurrent: () => true };
let selection: ReturnType<typeof useResolvedAssistantsStore.getState>;
let identity: ReturnType<typeof useAssistantIdentityStore.getState>;

beforeEach(() => {
  selection = useResolvedAssistantsStore.getState();
  identity = useAssistantIdentityStore.getState();
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
  useAssistantIdentityStore.setState({
    assistantId: "assistant-1",
    version: "0.11.12",
  });
  window.sessionStorage.clear();
  getConversation.mockReset();
  getConversation.mockImplementation(async ({ path }) => ({
    data: { conversation: { id: path.id } },
    response: new Response(null, { status: 200 }),
  }));
  createConversation.mockClear();
  createConversation.mockImplementation(async () => ({
    data: { id: "conv-created" },
  }));
  linkConversation.mockReset();
  linkConversation.mockImplementation(async () => ({}));
});

afterEach(() => {
  useResolvedAssistantsStore.setState(selection, true);
  useAssistantIdentityStore.setState(identity, true);
  window.sessionStorage.clear();
});

function missingConversation() {
  return {
    data: { conversation: { id: "" } },
    response: new Response(null, { status: 404 }),
  };
}

function cachedReplacement() {
  setEditChatConversationId("assistant-1", "surface-1", "conv-replacement");
  getConversation.mockImplementation(async ({ path }) =>
    path.id === "conv-existing"
      ? missingConversation()
      : {
          data: { conversation: { id: path.id } },
          response: new Response(null, { status: 200 }),
        },
  );
}

describe("document conversation entry", () => {
  test("uses the document's existing conversation without creating or linking", async () => {
    expect(await resolveDocumentConversation(options)).toBe("conv-existing");
    expect(createConversation).not.toHaveBeenCalled();
    expect(linkConversation).not.toHaveBeenCalled();
  });

  test("uses and links a cached valid replacement when the original is missing", async () => {
    cachedReplacement();
    expect(await resolveDocumentConversation(options)).toBe("conv-replacement");
    expect(linkConversation.mock.calls[0]?.[0].body.conversationId).toBe(
      "conv-replacement",
    );
    expect(createConversation).not.toHaveBeenCalled();
  });

  test("a legacy assistant reuses a valid cached conversation without the unsupported link write", async () => {
    cachedReplacement();
    useAssistantIdentityStore.setState({ version: "0.8.3" });
    linkConversation.mockImplementation(async () => {
      throw new Error("Route not found");
    });
    expect(await resolveDocumentConversation(options)).toBe("conv-replacement");
    expect(linkConversation).not.toHaveBeenCalled();
    expect(createConversation).not.toHaveBeenCalled();
    expect(getEditChatConversationId("assistant-1", "surface-1")).toBe(
      "conv-replacement",
    );
  });

  test.each([false, true])(
    "waits for the owning assistant version before linking, cancelled=%s",
    async (cancelled) => {
      cachedReplacement();
      useAssistantIdentityStore.setState({ assistantId: "assistant-2" });
      const scope = documentRequestScope("assistant-1");
      const pending = resolveDocumentConversation({ ...options, ...scope });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const prematureLinks = linkConversation.mock.calls.length;
      if (cancelled) {
        useResolvedAssistantsStore.setState({
          activeAssistantId: "assistant-2",
        });
        useResolvedAssistantsStore.setState({
          activeAssistantId: "assistant-1",
        });
      }
      useAssistantIdentityStore.setState({
        assistantId: "assistant-1",
        version: "0.8.4",
      });
      const result = await pending;
      scope.dispose();
      expect(prematureLinks).toBe(0);
      expect(result).toBe(cancelled ? null : "conv-replacement");
      expect(linkConversation).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    },
  );

  test.each([404, 403, 503])(
    "a supported assistant's %s link failure cannot silently navigate",
    async (status) => {
      cachedReplacement();
      const error = Object.assign(new Error("Link failed"), { status });
      linkConversation.mockImplementation(async () => {
        throw error;
      });
      await expect(resolveDocumentConversation(options)).rejects.toBe(error);
      expect(createConversation).not.toHaveBeenCalled();
    },
  );

  test("missing conversation returns an explicit recovery state without mutation", async () => {
    getConversation.mockImplementation(async () => missingConversation());
    expect(await resolveDocumentConversation(options)).toBeNull();
    expect(createConversation).not.toHaveBeenCalled();
    expect(linkConversation).not.toHaveBeenCalled();
  });

  test("a transport or server error is not treated as a deleted conversation", async () => {
    getConversation.mockImplementation(async () => ({
      data: { conversation: { id: "" } },
      response: new Response(null, { status: 503 }),
    }));
    await expect(resolveDocumentConversation(options)).rejects.toThrow();
    expect(createConversation).not.toHaveBeenCalled();
  });

  test("the explicit recovery action reuses a created row when linking needs a retry", async () => {
    getConversation.mockImplementation(async ({ path }) =>
      path.id === "conv-created"
        ? {
            data: { conversation: { id: path.id } },
            response: new Response(null, { status: 200 }),
          }
        : missingConversation(),
    );
    linkConversation.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await expect(startDocumentConversation(options)).rejects.toThrow("offline");
    expect(getEditChatConversationId("assistant-1", "surface-1")).toBe(
      "conv-created",
    );
    expect(await startDocumentConversation(options)).toBe("conv-created");
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(linkConversation).toHaveBeenCalledTimes(2);
  });

  test("creation retries use one key when the first creation response is lost", async () => {
    getConversation.mockImplementation(async () => missingConversation());
    createConversation.mockImplementationOnce(async () => {
      throw new Error("response lost");
    });
    await expect(startDocumentConversation(options)).rejects.toThrow(
      "response lost",
    );
    expect(await startDocumentConversation(options)).toBe("conv-created");
    expect(createConversation.mock.calls[0]?.[0].body.conversationKey).toBe(
      createConversation.mock.calls[1]?.[0].body.conversationKey,
    );
  });

  test("a switched owner cannot link after an awaited lookup", async () => {
    let current = true;
    getConversation.mockImplementation(async () => {
      current = false;
      return {
        data: { conversation: { id: "conv-canonical" } },
        response: new Response(null, { status: 200 }),
      };
    });
    expect(
      await resolveDocumentConversation({
        ...options,
        isCurrent: () => current,
      }),
    ).toBeNull();
    expect(linkConversation).not.toHaveBeenCalled();
  });

  test("assistant switch away and back permanently cancels the request", () => {
    const scope = documentRequestScope("assistant-1");
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-2" });
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    expect(scope.isCurrent()).toBe(false);
    scope.dispose();
  });

  test("explicit creation is blocked on an unsupported assistant", async () => {
    useAssistantIdentityStore.setState({ version: "0.8.5" });
    await expect(startDocumentConversation(options)).rejects.toThrow(
      "Update your assistant",
    );
    expect(createConversation).not.toHaveBeenCalled();
  });
});
