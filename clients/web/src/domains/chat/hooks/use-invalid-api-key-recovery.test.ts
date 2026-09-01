import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";

const inferenceprofilePut = mock(async () => ({ data: {} }));
const activeprofilePut = mock(async () => ({ data: {} }));
const toastSuccess = mock((_msg: string) => {});
const toastError = mock((_msg: string) => {});
const setError = mock((_error: unknown) => {});
const setPendingDraftProfile = mock((_id: string, _name: string) => {});

mock.module("@/generated/daemon/sdk.gen", () => ({
  conversationsByIdInferenceprofilePut: inferenceprofilePut,
  inferenceActiveprofilePut: activeprofilePut,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: mock(() => {}),
}));

mock.module("@/lib/backwards-compat/complete-profile-snapshots", () => ({
  useSupportsCompleteProfileSnapshots: () => true,
}));

mock.module("@/lib/backwards-compat/use-supports-active-profile-route", () => ({
  useSupportsActiveProfileRoute: () => true,
}));

mock.module("@/domains/chat/chat-session-store", () => ({
  useChatSessionStore: {
    getState: () => ({ setError }),
  },
}));

mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    getState: () => ({ setPendingDraftProfile }),
  },
}));

const configData = {
  llm: {
    activeProfile: "glm-5-2",
    profileOrder: ["balanced", "glm-5-2"],
    profiles: {
      balanced: {
        source: "managed",
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
        label: "Balanced",
      },
      "glm-5-2": {
        source: "user",
        provider: "openai-compatible",
        model: "glm-5-2",
        label: "GLM",
      },
    },
  },
};

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config"],
    queryFn: async () => configData,
  }),
  configGetQueryKey: () => ["config"],
  conversationsByIdGetOptions: () => ({
    queryKey: ["conversation"],
    queryFn: async () => ({
      conversation: { inferenceProfile: "glm-5-2" },
    }),
  }),
  conversationsByIdGetQueryKey: () => ["conversation"],
  inferenceProfilesGetQueryKey: () => ["inference-profiles"],
}));

import { useInvalidApiKeyRecovery } from "@/domains/chat/hooks/use-invalid-api-key-recovery";

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useInvalidApiKeyRecovery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    inferenceprofilePut.mockClear();
    activeprofilePut.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
    setError.mockClear();
    setPendingDraftProfile.mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  test("pins the conversation and workspace default to a managed profile", async () => {
    const { result } = renderHook(
      () =>
        useInvalidApiKeyRecovery({
          assistantId: "asst-1",
          conversationId: "conv-xyz",
          isDraft: false,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.canUseDefaultModel).toBe(true);
    });

    await act(async () => {
      await result.current.useDefaultModel();
    });

    expect(inferenceprofilePut).toHaveBeenCalledWith({
      path: { assistant_id: "asst-1", id: "conv-xyz" },
      body: { profile: "balanced" },
      throwOnError: true,
    });
    expect(activeprofilePut).toHaveBeenCalledWith({
      path: { assistant_id: "asst-1" },
      body: { name: "balanced" },
      throwOnError: true,
    });
    expect(setError).toHaveBeenCalledWith(null);
    expect(toastSuccess).toHaveBeenCalled();
  });

  test("stashes a draft profile instead of writing the conversation override", async () => {
    const { result } = renderHook(
      () =>
        useInvalidApiKeyRecovery({
          assistantId: "asst-1",
          conversationId: "draft-xyz",
          isDraft: true,
        }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.canUseDefaultModel).toBe(true);
    });

    await act(async () => {
      await result.current.useDefaultModel();
    });

    expect(inferenceprofilePut).not.toHaveBeenCalled();
    expect(setPendingDraftProfile).toHaveBeenCalledWith("draft-xyz", "balanced");
    expect(activeprofilePut).toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(null);
  });
});
