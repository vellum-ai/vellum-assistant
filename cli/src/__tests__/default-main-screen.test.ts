import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  fetchAssistantDisplayName,
  shouldRefreshAssistantIdentity,
} from "../components/DefaultMainScreen";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("DefaultMainScreen identity helpers", () => {
  test("fetchAssistantDisplayName reads and trims the runtime identity name", async () => {
    const fetchMock = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "http://127.0.0.1:7833/v1/assistants/assistant-1/identity",
      );
      return new Response(JSON.stringify({ name: "  Hatch  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      fetchAssistantDisplayName("http://127.0.0.1:7833", "assistant-1"),
    ).resolves.toBe("Hatch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("fetchAssistantDisplayName treats blank identity names as absent", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ name: "   " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      fetchAssistantDisplayName("http://127.0.0.1:7833", "assistant-1"),
    ).resolves.toBeUndefined();
  });

  test("shouldRefreshAssistantIdentity recognizes identity events", () => {
    expect(
      shouldRefreshAssistantIdentity({
        type: "sync_changed",
        tags: ["assistant:self:identity"],
      }),
    ).toBe(true);

    expect(shouldRefreshAssistantIdentity({ type: "identity_changed" })).toBe(
      true,
    );

    expect(
      shouldRefreshAssistantIdentity({
        type: "sync_changed",
        tags: ["conversations:list"],
      }),
    ).toBe(false);
  });
});
