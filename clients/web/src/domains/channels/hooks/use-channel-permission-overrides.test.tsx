/**
 * Tests for `useChannelPermissionOverrides`'s failure classification (LUM-2732).
 *
 * The cell list has two distinct failure axes, and they resolve differently. A
 * gateway with no list route (404/501) can't serve the surface at all, so the
 * controller degrades to the read-only channel list. Any other failure (5xx,
 * auth, a dropped connection) self-heals on the next refetch, so the controller
 * stays `supported` and reports `isError`, letting the caller disable the
 * pickers and say why.
 *
 * The generated list-options factory and gateway SDK are `mock.module`-replaced
 * so each test controls exactly what the query rejects with. The QueryClient
 * uses `retry: false` so failures land on the first attempt.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const LIST_KEY = ["channel-permission-overrides"];

/** What the mocked list query does; each test seeds it. */
let listImpl: () => Promise<{ cells: unknown[] }>;
/** Seeded by the version-gate test. */
let supportsAccessControls = true;

mock.module("@/generated/gateway/@tanstack/react-query.gen", () => ({
  assistantChannelPermissionOverridesListOptions: () => ({
    queryKey: LIST_KEY,
    queryFn: () => listImpl(),
  }),
  assistantChannelPermissionOverridesListQueryKey: () => LIST_KEY,
}));

mock.module("@/generated/gateway/sdk.gen", () => ({
  assistantChannelPermissionOverrideSet: async () => ({}),
  assistantChannelPermissionOverrideDelete: async () => ({}),
  assistantChannelPermissionResolve: async () => ({
    data: { resolved: null },
  }),
}));

mock.module("@/lib/backwards-compat/channel-access-controls", () => ({
  useSupportsChannelAccessControls: () => supportsAccessControls,
}));

const { useChannelPermissionOverrides } =
  await import("./use-channel-permission-overrides");

/**
 * An HTTP failure carrying `status` directly, the shape `ApiError` and the
 * HeyAPI client throw.
 */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function renderController() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useChannelPermissionOverrides({
        assistantId: "assistant-123",
        adapter: "slack",
      }),
    { wrapper },
  );
}

beforeEach(() => {
  supportsAccessControls = true;
  listImpl = async () => ({ cells: [] });
});

afterEach(() => {
  cleanup();
});

describe("useChannelPermissionOverrides failure classification", () => {
  test("degrades to unsupported when the list route 404s", async () => {
    listImpl = async () => {
      throw httpError(404);
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.supported).toBe(false));
    // Not an error state: there is nothing to report, the surface just isn't
    // available. Holding a picker disabled here would strand it forever.
    expect(result.current.isError).toBe(false);
    expect(result.current.onTierChange).toBeUndefined();
    expect(result.current.onBucketChange).toBeUndefined();
  });

  test("degrades to unsupported when the list route 501s", async () => {
    listImpl = async () => {
      throw httpError(501);
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.isError).toBe(false);
  });

  test("reads the status off a Response-shaped error too", async () => {
    // The HeyAPI client surfaces some failures as `{ response: { status } }`.
    listImpl = async () => {
      throw Object.assign(new Error("Not Found"), {
        response: { status: 404 },
      });
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(result.current.isError).toBe(false);
  });

  test("reports isError on a 5xx, keeping the surface and its handlers", async () => {
    listImpl = async () => {
      throw httpError(500);
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.supported).toBe(true);
    // Handlers must survive: the section reads their absence as "this assistant
    // can't serve the surface" and would fall back to the read-only list.
    expect(typeof result.current.onTierChange).toBe("function");
    expect(typeof result.current.onTierReset).toBe("function");
    expect(typeof result.current.onBucketChange).toBe("function");
    expect(typeof result.current.onBucketReset).toBe("function");
    // Nothing loaded, so the caller has no stored cells to render.
    expect(result.current.tierOverrides).toBeUndefined();
    expect(result.current.bucketTiers).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  test("reports isError on a statusless network failure", async () => {
    listImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.supported).toBe(true);
  });

  test("reports isError on an auth failure rather than hiding the surface", async () => {
    listImpl = async () => {
      throw httpError(403);
    };
    const { result } = renderController();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.supported).toBe(true);
  });

  test("maps cells and reports no error on success", async () => {
    listImpl = async () => ({
      cells: [
        {
          selector: {
            scope: "channel",
            adapter: "slack",
            channelExternalId: "C1",
          },
          contactType: "trusted_contact",
          threshold: "none",
        },
        {
          selector: { scope: "adapter", adapter: "slack" },
          contactType: "trusted_contact",
          threshold: "low",
        },
      ],
    });
    const { result } = renderController();

    await waitFor(() =>
      expect(result.current.tierOverrides).toEqual({ C1: "none" }),
    );
    expect(result.current.supported).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.bucketTiers).toEqual({
      channels: "low",
      dm: undefined,
    });
  });

  test("stays unsupported with no error when the version gate is off", async () => {
    supportsAccessControls = false;
    listImpl = async () => {
      throw new Error("should never be called");
    };
    const { result } = renderController();

    expect(result.current.supported).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.onTierChange).toBeUndefined();
  });
});
