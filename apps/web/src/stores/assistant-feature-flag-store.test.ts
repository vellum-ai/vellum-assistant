import { beforeEach, describe, expect, mock, test } from "bun:test";

const patchMock = mock((_request: unknown) =>
  Promise.resolve({ response: new Response(null, { status: 204 }) }),
);

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock },
}));

const toastErrorMock = mock((_message: string) => {});

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastErrorMock, success: () => {} },
}));

import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

function store() {
  return useAssistantFeatureFlagStore.getState();
}

beforeEach(() => {
  store().resetForAssistantSwitch();
  patchMock.mockReset();
  patchMock.mockImplementation((_request: unknown) =>
    Promise.resolve({ response: new Response(null, { status: 204 }) }),
  );
  toastErrorMock.mockReset();
});

describe("useAssistantFeatureFlagStore", () => {
  test("keeps an optimistic assistant flag update when the server accepts it", async () => {
    store().setFlag("selfIntroGreeting", true, "assistant-123");

    expect(store().selfIntroGreeting).toBe(true);
    await Promise.resolve();

    expect(store().selfIntroGreeting).toBe(true);
    const request = patchMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "/v1/assistants/assistant-123/feature-flags/self-intro-greeting",
      body: { enabled: true },
      throwOnError: false,
    });
  });

  test("reverts an optimistic assistant flag update when the server rejects it", async () => {
    let resolvePatch:
      | ((value: { response: Response }) => void)
      | undefined;
    patchMock.mockImplementation(
      (_request: unknown) =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        }),
    );

    store().setFlag("selfIntroGreeting", true, "assistant-123");
    expect(store().selfIntroGreeting).toBe(true);

    resolvePatch?.({ response: new Response(null, { status: 400 }) });
    await Promise.resolve();

    expect(store().selfIntroGreeting).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  test("reverts to the last confirmed value when repeated optimistic updates are rejected", async () => {
    const resolvePatches: Array<(value: { response: Response }) => void> = [];
    patchMock.mockImplementation(
      (_request: unknown) =>
        new Promise((resolve) => {
          resolvePatches.push(resolve);
        }),
    );

    store().setFlag("selfIntroGreeting", true, "assistant-123");
    expect(store().selfIntroGreeting).toBe(true);

    store().setFlag("selfIntroGreeting", false, "assistant-123");
    expect(store().selfIntroGreeting).toBe(false);

    resolvePatches[0]?.({ response: new Response(null, { status: 400 }) });
    await Promise.resolve();
    expect(store().selfIntroGreeting).toBe(false);

    resolvePatches[1]?.({ response: new Response(null, { status: 400 }) });
    await Promise.resolve();
    expect(store().selfIntroGreeting).toBe(false);
  });

  test("is a no-op for an assistant flag when there is no assistant id", async () => {
    store().setFlag("memoryRetrospectiveFork", true, null);
    await Promise.resolve();

    // No assistant id => nowhere to persist => true no-op. It must not apply an
    // optimistic value or fake a "confirmed" one: a local-only write is exactly
    // what masked the silent persistence failure (the toggle looked saved while
    // the gateway, and therefore the daemon, never received it).
    expect(store().memoryRetrospectiveFork).toBe(false);
    expect(patchMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
