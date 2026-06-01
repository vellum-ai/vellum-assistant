import { beforeEach, describe, expect, mock, test } from "bun:test";

const patchMock = mock((_request: unknown) =>
  Promise.resolve({ response: new Response(null, { status: 204 }) }),
);

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock },
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

  test("keeps local-only assistant flag updates when there is no assistant id", async () => {
    store().setFlag("selfIntroGreeting", true, null);
    await Promise.resolve();

    expect(store().selfIntroGreeting).toBe(true);
    expect(patchMock).not.toHaveBeenCalled();
  });
});
