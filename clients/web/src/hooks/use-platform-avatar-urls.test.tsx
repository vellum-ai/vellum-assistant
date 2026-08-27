/**
 * Tests for `usePlatformAvatarUrls`: the enable gate (live platform session
 * in a lockfile-driven mode, org header ready), the id-to-url reduction, the
 * failure-to-empty-map contract, one list call shared by every consumer, and
 * the promise never to write the resolved-assistants store. The auth and
 * resolved stores are real; the environment probes and the assistants API are
 * mocked at the module boundary.
 */

import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type * as AssistantApi from "@/assistant/api";
import type { Assistant } from "@/generated/api";

const actualLocalMode = await import("@/lib/local-mode");
let localClient = false;
let remoteGatewayMode = false;
mock.module("@/lib/local-mode", () => ({
  ...actualLocalMode,
  isLocalClient: () => localClient,
  isRemoteGatewayMode: () => remoteGatewayMode,
}));

let gatewayAuthEnabled = false;
mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => gatewayAuthEnabled,
}));

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const resolvePairedAssistantPlatformId = mock(
  async (_id: string): Promise<string | null> => null,
);
mock.module("@/lib/paired-platform-identity", () => ({
  resolvePairedAssistantPlatformId,
}));

const listAssistants = mock(
  async (): Promise<AssistantApi.ListAssistantsResult> => ({
    ok: true,
    status: 200,
    data: [],
  }),
);
const actualApi = await import("@/assistant/api");
mock.module("@/assistant/api", () => ({ ...actualApi, listAssistants }));

const { useAuthStore } = await import("@/stores/auth-store");
const { useOrganizationStore } = await import("@/stores/organization-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const {
  platformAvatarUrlsQueryKey,
  supersedePlatformAvatar,
  suppressPlatformAvatarUrl,
  usePlatformAvatarUrls,
} = await import("@/hooks/use-platform-avatar-urls");
const { AVATAR_SUPERSEDE_WINDOW_MS, resetAvatarSupersedeForTests } =
  await import("@/lib/avatar-supersede");

const initialAuthState = useAuthStore.getState();

const apiAssistant = (id: string, avatar_url: string | null): Assistant =>
  ({ id, avatar_url }) as Assistant;

const WITH_AVATAR = "https://cdn.example/avatars/a.png";

function createWrapper(
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function signIn(userId = "user-1"): void {
  useAuthStore.setState({
    platformSession: "present",
    user: {
      kind: "platform",
      id: userId,
      username: null,
      email: null,
      isStaff: false,
      firstName: "",
      lastName: "",
    },
  });
}

beforeEach(() => {
  localClient = true;
  remoteGatewayMode = false;
  gatewayAuthEnabled = false;
  orgReady = true;
  resetAvatarSupersedeForTests();
  resolvePairedAssistantPlatformId.mockClear();
  signIn();
  listAssistants.mockResolvedValue({
    ok: true,
    status: 200,
    data: [
      apiAssistant("a", WITH_AVATAR),
      apiAssistant("b", null),
      apiAssistant("c", ""),
    ],
  });
});

afterEach(() => {
  cleanup();
  setSystemTime();
  listAssistants.mockReset();
  useAuthStore.setState(initialAuthState, true);
});

describe("usePlatformAvatarUrls", () => {
  test.each([
    ["local client", () => (localClient = true)],
    [
      "remote-gateway mode",
      () => {
        localClient = false;
        remoteGatewayMode = true;
      },
    ],
  ])("maps id to a non-empty avatar_url under %s", async (_l, arrange) => {
    arrange();
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });
    expect(result.current.has("b")).toBe(false);
    expect(result.current.has("c")).toBe(false);
    expect(listAssistants).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "no live platform session",
      () => useAuthStore.setState({ platformSession: "absent", user: null }),
    ],
    [
      "an unsettled platform session",
      () => useAuthStore.setState({ platformSession: "unknown" }),
    ],
    ["pure cloud mode", () => (localClient = false)],
    ["gateway auth", () => (gatewayAuthEnabled = true)],
    ["an unready org header", () => (orgReady = false)],
  ])("stays idle with %s", async (_l, arrange) => {
    arrange();
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(),
    });
    await settle();
    expect(result.current.size).toBe(0);
    expect(listAssistants).not.toHaveBeenCalled();
  });

  test("a rejected list resolves to an empty map", async () => {
    listAssistants.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(listAssistants).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(result.current.size).toBe(0);
  });

  test("a non-ok list resolves to an empty map", async () => {
    listAssistants.mockResolvedValue({ ok: false, status: 500, error: {} });
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(listAssistants).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(result.current.size).toBe(0);
  });

  test("a failed poll keeps the last good map", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });

    listAssistants.mockRejectedValueOnce(new Error("offline"));
    await act(() =>
      queryClient.refetchQueries({ queryKey: ["platformAvatarUrls"] }),
    );
    expect(listAssistants).toHaveBeenCalledTimes(2);
    await settle();
    expect(result.current.get("a")).toBe(WITH_AVATAR);
  });

  test("one list call serves every consumer in a stale window", async () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => [
        usePlatformAvatarUrls(),
        usePlatformAvatarUrls(),
        usePlatformAvatarUrls(),
      ],
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current[0]?.get("a")).toBe(WITH_AVATAR);
    });
    renderHook(() => usePlatformAvatarUrls(), { wrapper });
    await settle();
    expect(listAssistants).toHaveBeenCalledTimes(1);
  });

  test("a different user gets a fresh list", async () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => usePlatformAvatarUrls(), { wrapper });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });

    act(() => signIn("user-2"));

    await waitFor(() => {
      expect(listAssistants).toHaveBeenCalledTimes(2);
    });
  });

  test("an organization switch gets a fresh list", async () => {
    const wrapper = createWrapper();
    const { result } = renderHook(() => usePlatformAvatarUrls(), { wrapper });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });

    act(() =>
      useOrganizationStore.setState({ currentOrganizationId: "org-2" }),
    );

    await waitFor(() => {
      expect(listAssistants).toHaveBeenCalledTimes(2);
    });
    useOrganizationStore.setState({ currentOrganizationId: null });
  });

  test("never writes the resolved-assistants store", async () => {
    const setState = spyOn(useResolvedAssistantsStore, "setState");
    const before = useResolvedAssistantsStore.getState().assistants;
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });
    expect(setState).not.toHaveBeenCalled();
    expect(useResolvedAssistantsStore.getState().assistants).toBe(before);
    setState.mockRestore();
  });
});

describe("suppressPlatformAvatarUrl", () => {
  function deferredList() {
    let resolveList!: (value: AssistantApi.ListAssistantsResult) => void;
    listAssistants.mockReturnValueOnce(
      new Promise<AssistantApi.ListAssistantsResult>((resolve) => {
        resolveList = resolve;
      }),
    );
    return (data: Assistant[]) => resolveList({ ok: true, status: 200, data });
  }

  test("drops the id from a cached map", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });

    act(() => suppressPlatformAvatarUrl(queryClient, "a"));

    await waitFor(() => {
      expect(result.current.has("a")).toBe(false);
    });
    expect(listAssistants).toHaveBeenCalledTimes(1);
  });

  test("a list in flight during suppression lands its siblings without the stale url", async () => {
    const resolveList = deferredList();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(listAssistants).toHaveBeenCalledTimes(1);
    });

    act(() => suppressPlatformAvatarUrl(queryClient, "a"));
    resolveList([
      apiAssistant("a", WITH_AVATAR),
      apiAssistant("sibling", "https://cdn.example/avatars/sibling.png"),
    ]);

    await waitFor(() => {
      expect(result.current.get("sibling")).toBe(
        "https://cdn.example/avatars/sibling.png",
      );
    });
    expect(result.current.has("a")).toBe(false);
    expect(listAssistants).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(platformAvatarUrlsQueryKey("user-1", null))
        ?.status,
    ).toBe("success");
  });

  test("a list started inside the window still omits the id; one after it carries it again", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => usePlatformAvatarUrls(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });

    act(() => suppressPlatformAvatarUrl(queryClient, "a"));
    await waitFor(() => {
      expect(result.current.has("a")).toBe(false);
    });

    await act(() =>
      queryClient.refetchQueries({ queryKey: ["platformAvatarUrls"] }),
    );
    expect(listAssistants).toHaveBeenCalledTimes(2);
    await settle();
    expect(result.current.has("a")).toBe(false);

    setSystemTime(new Date(Date.now() + AVATAR_SUPERSEDE_WINDOW_MS));
    await act(() =>
      queryClient.refetchQueries({ queryKey: ["platformAvatarUrls"] }),
    );
    expect(listAssistants).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(result.current.get("a")).toBe(WITH_AVATAR);
    });
  });
});

describe("supersedePlatformAvatar", () => {
  const PAIRED_UUID = "11111111-2222-4333-8444-555555555555";

  test("a paired row without a persisted UUID is suppressed under the UUID the daemon answers", async () => {
    resolvePairedAssistantPlatformId.mockResolvedValueOnce(PAIRED_UUID);
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "paired-slug",
          isLocal: false,
          isPlatformHosted: false,
          isPaired: true,
          cloud: "paired",
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const key = platformAvatarUrlsQueryKey("user-1", null);
    queryClient.setQueryData(key, new Map([[PAIRED_UUID, WITH_AVATAR]]));

    act(() => supersedePlatformAvatar(queryClient, "paired-slug"));

    await waitFor(() => {
      expect(resolvePairedAssistantPlatformId).toHaveBeenCalledWith(
        "paired-slug",
      );
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<Map<string, string>>(key)?.has(PAIRED_UUID),
      ).toBe(false);
    });
  });

  test("a row with a known platform id never asks the paired daemon", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "paired-slug",
          isLocal: false,
          isPlatformHosted: false,
          isPaired: true,
          cloud: "paired",
          platformAssistantId: PAIRED_UUID,
        },
      ],
    });
    const queryClient = new QueryClient();
    const key = platformAvatarUrlsQueryKey("user-1", null);
    queryClient.setQueryData(key, new Map([[PAIRED_UUID, WITH_AVATAR]]));

    supersedePlatformAvatar(queryClient, "paired-slug");

    expect(resolvePairedAssistantPlatformId).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData<Map<string, string>>(key)?.has(PAIRED_UUID),
    ).toBe(false);
  });
});
