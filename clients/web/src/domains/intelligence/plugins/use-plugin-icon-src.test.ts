/**
 * Tests for `usePluginIconSrc`. The hook fetches the bundled icon through the
 * authenticated daemon client (so the request interceptor + auth run, unlike a
 * bare `<img src>`) and returns it as an object URL, or `undefined` when the
 * version gate is off or the plugin ships no icon (in which case it never
 * fetches).
 *
 * The generated SDK and the object-URL helpers are mocked; the version gate is
 * driven the real way, by seeding the assistant identity store (the SDK mock
 * spreads the real module so no export is dropped for other suites in the run).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-plugin-icons";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";
const NAME = "simple-memory";
const VERSION = "abc123";

type IconResult = { data: Blob | null; error: { message: string } | null };

// Per-test holder the SDK mock reads.
let iconResult: IconResult;

const sdkActual = await import("@/generated/daemon/sdk.gen");
const pluginsByNameIconGetSpy = mock(
  async (_options: unknown): Promise<IconResult> => iconResult,
);
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsByNameIconGet: pluginsByNameIconGetSpy,
}));

// happy-dom doesn't implement object URLs.
const createObjectURL = mock(
  (_obj: Blob | MediaSource): string => "blob:icon-mock",
);
const revokeObjectURL = mock((_url: string): void => undefined);
globalThis.URL.createObjectURL = createObjectURL;
globalThis.URL.revokeObjectURL = revokeObjectURL;

const { usePluginIconSrc } =
  await import("@/domains/intelligence/plugins/use-plugin-icon-src");

function renderIconSrc(
  hasIcon: boolean | undefined,
  iconVersion: string | null | undefined,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return renderHook(
    () => usePluginIconSrc(ASSISTANT_ID, NAME, hasIcon, iconVersion),
    { wrapper },
  );
}

beforeEach(() => {
  // Gate open by default; individual cases override.
  useAssistantIdentityStore.setState({ version: MIN_VERSION });
  iconResult = { data: new Blob(["icon"]), error: null };
  pluginsByNameIconGetSpy.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.setState({ version: null });
});

describe("usePluginIconSrc", () => {
  test("fetches through the daemon client and returns an object URL when gated + hasIcon", async () => {
    const { result } = renderIconSrc(true, VERSION);

    await waitFor(() => expect(result.current).toBe("blob:icon-mock"));

    expect(pluginsByNameIconGetSpy).toHaveBeenCalledTimes(1);
    expect(pluginsByNameIconGetSpy.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
      parseAs: "blob",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test("returns undefined and never fetches when the version gate is off", async () => {
    // Older daemon: no icon endpoint.
    useAssistantIdentityStore.setState({ version: null });

    const { result } = renderIconSrc(true, VERSION);

    // Give any (unexpected) query a chance to fire before asserting no fetch.
    await Promise.resolve();
    expect(result.current).toBeUndefined();
    expect(pluginsByNameIconGetSpy).not.toHaveBeenCalled();
  });

  test("returns undefined and never fetches when the plugin ships no icon", async () => {
    const { result } = renderIconSrc(false, undefined);

    await Promise.resolve();
    expect(result.current).toBeUndefined();
    expect(pluginsByNameIconGetSpy).not.toHaveBeenCalled();
  });

  test("returns undefined and never fetches when iconVersion is missing", async () => {
    const { result } = renderIconSrc(true, null);

    await Promise.resolve();
    expect(result.current).toBeUndefined();
    expect(pluginsByNameIconGetSpy).not.toHaveBeenCalled();
  });

  test("stays undefined when the fetch fails (falls through to the glyph)", async () => {
    iconResult = { data: null, error: { message: "boom" } };

    const { result } = renderIconSrc(true, VERSION);

    await waitFor(() =>
      expect(pluginsByNameIconGetSpy).toHaveBeenCalledTimes(1),
    );
    expect(result.current).toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test("revokes the object URL on unmount", async () => {
    const { result, unmount } = renderIconSrc(true, VERSION);

    await waitFor(() => expect(result.current).toBe("blob:icon-mock"));

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-mock");
  });
});
