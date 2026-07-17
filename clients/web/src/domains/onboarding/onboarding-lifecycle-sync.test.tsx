import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode } from "react";

import type { PlatformSessionStatus } from "@/stores/session-status";
import { routes } from "@/utils/routes";

let searchParams = new URLSearchParams();
const navigateMock = mock(() => {});

let checkAssistantImpl: () => Promise<void> = async () => {};
const checkAssistantMock = mock(() => checkAssistantImpl());

const hatchAssistantMock = mock(async () => ({
  ok: true,
  status: 201,
  data: {
    id: "asst-1",
    status: "initializing",
    is_local: false,
    maintenance_mode: { enabled: false },
  },
}));

const assistantResult = (status: string) => ({
  ok: true,
  status: 200,
  data: {
    id: "asst-1",
    status,
    is_local: false,
    maintenance_mode: { enabled: false },
  },
});
let getAssistantImpl: () => Promise<unknown> = async () =>
  assistantResult("active");
const getAssistantMock = mock(() => getAssistantImpl());

let fetchTraitsImpl: () => Promise<unknown> = async () => null;
const fetchCharacterTraitsMock = mock(() => fetchTraitsImpl());
const saveCharacterTraitsMock = mock(async () => undefined);
const invalidateQueriesMock = mock(() => {});
const queryClientMock = {
  fetchQuery: mock(async () => []),
  invalidateQueries: invalidateQueriesMock,
};
const writeSelectedVersionMock = mock(() => {});
const connectLocalAssistantMock = mock(async (_assistantId: string) => {});

let isLocalModeValue = false;
let localGatewayUrlValue: string | undefined = undefined;
let platformSessionValue: PlatformSessionStatus = "absent";

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: checkAssistantMock,
    markExpectingFirstMessage: () => {},
  },
}));

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  getAssistant: getAssistantMock,
  getAssistantHealthz: async () => ({
    ok: true,
    status: 200,
    data: { status: "ok" },
  }),
}));

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterTraits: fetchCharacterTraitsMock,
  saveCharacterTraits: saveCharacterTraitsMock,
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  avatarQueryKey: (assistantId: string) => ["assistantAvatar", assistantId],
  AVATAR_QUERY_KEY_PREFIX: "assistantAvatar",
}));

mock.module("@/utils/avatar-bundled-components", () => ({
  BUNDLED_COMPONENTS: {},
}));

mock.module("@/utils/avatar-random", () => ({
  randomCharacterTraits: () => ({
    bodyShape: "round",
    eyeStyle: "dot",
    color: "green",
  }),
}));

mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: () => "<svg />",
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

mock.module("@vellumai/design-library/components/progress-bar", () => ({
  ProgressBar: ({ value }: { value: number }) => (
    <div data-testid="progress" data-value={value} />
  ),
}));

mock.module("@sentry/browser", () => ({
  captureException: mock(() => {}),
  captureMessage: mock(() => {}),
  setContext: () => {},
}));
mock.module("@sentry/react", () => ({
  captureException: mock(() => {}),
  captureMessage: mock(() => {}),
  setContext: () => {},
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readPrivacyConsent: () => true,
  readSelectedVersion: () => null,
  isAnalyticsEnabled: () => true,
  readTosAccepted: () => true,
  writeSelectedVersion: writeSelectedVersionMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  resolveNavigation: () => ({ action: "allow" }),
}));

mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: (overrides: Record<string, unknown> = {}) => ({
    isLocalMode: isLocalModeValue,
    isGatewayAuth: false,
    hasAssistants: false,
    sessionSettled: true,
    isAuthenticated: true,
    platformSession: platformSessionValue,
    tosAccepted: true,
    privacyConsent: true,
    ...overrides,
  }),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  useIsNativePlatform: () => false,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => isLocalModeValue,
  isRemoteGatewayMode: () => false,
  isLocalAssistant: () => false,
  isPlatformAssistant: () => false,
  isPlatformDisabled: () => false,
  hasAssistants: () => false,
  getPlatformAssistants: () => [],
  getPlatformRuntimeUrl: () => "https://platform.vellum.ai",
  getActiveAssistant: () => null,
  getSelectedAssistant: () => undefined,
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  setActiveLockfileAssistant: async () => {},
  saveLockfileAssistant: async () => {},
  updateLockfileAssistant: async () => {},
  primeLocalGatewayConnection: async () => {},
  primeLocalGatewayConnectionWithRepair: async () => {},
  getLocalGatewayUrl: () => localGatewayUrlValue,
  // Mirrors the real probe against the mocked gateway URL, so tests that stub
  // `globalThis.fetch` keep driving the readyz loop the same way.
  probeLocalGatewayReady: async () => {
    if (!localGatewayUrlValue) {
      return false;
    }
    try {
      const res = await fetch(`${localGatewayUrlValue}/readyz`);
      if (!res.ok) {
        return false;
      }
      const body: unknown = await res.json();
      return (
        body !== null &&
        typeof body === "object" &&
        "status" in body &&
        (body as { status?: unknown }).status === "ok"
      );
    } catch {
      return false;
    }
  },
}));

mock.module("@/runtime/local-mode-host", () => ({
  hatchLocalAssistant: async () => ({ ok: true, assistantId: "local-1" }),
}));

mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: async () => {},
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      assistants: [],
      activeAssistantId: null,
      selectedAssistantId: null,
      assistantsHydrated: true,
      upsertFromApi: () => {},
      setActiveAssistantId: () => {},
      setSelectedAssistant: () => {},
    }),
    use: {
      assistants: () => [],
      activeAssistantId: () => null,
      selectedAssistantId: () => null,
    },
  },
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({
        id: "user-1",
        firstName: "Alice",
        lastName: "",
      }),
      sessionStatus: () => "authenticated",
      platformSession: () => platformSessionValue,
    },
    getState: () => ({ connectLocalAssistant: connectLocalAssistantMock }),
  },
  useIsAuthenticated: () => true,
  useIsSessionInitializing: () => false,
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { id: "asst-1" }, isLoading: false }),
  useMutation: () => ({ mutate: mock(() => {}), isPending: false }),
  useQueryClient: () => queryClientMock,
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsActiveRetrieveOptions: () => ({}),
  assistantsOauthConnectionsListOptions: () => ({}),
  useAssistantsOauthStartCreateMutation: () => ({
    mutate: mock(() => {}),
    isPending: false,
  }),
}));

const { HatchingScreen } =
  await import("@/domains/onboarding/pages/hatching-screen");

beforeEach(() => {
  searchParams = new URLSearchParams();
  checkAssistantImpl = async () => {};
  fetchTraitsImpl = async () => null;
  getAssistantImpl = async () => assistantResult("active");
  isLocalModeValue = false;
  localGatewayUrlValue = undefined;
  platformSessionValue = "absent";
  sessionStorage.clear();
  localStorage.clear();

  navigateMock.mockClear();
  connectLocalAssistantMock.mockClear();
  checkAssistantMock.mockClear();
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  fetchCharacterTraitsMock.mockClear();
  saveCharacterTraitsMock.mockClear();
  invalidateQueriesMock.mockClear();
  writeSelectedVersionMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("onboarding lifecycle sync", () => {
  test("hatching refreshes the root assistant lifecycle before leaving onboarding", async () => {
    let resolveLifecycle!: () => void;
    checkAssistantImpl = () =>
      new Promise<void>((resolve) => {
        resolveLifecycle = resolve;
      });

    render(<HatchingScreen />);

    await waitFor(() => expect(getAssistantMock).toHaveBeenCalled());
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(navigateMock).not.toHaveBeenCalled();

    resolveLifecycle();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
        replace: true,
      }),
    );
  });

  // Regression: a freshly hatched local assistant must establish an
  // authenticated session before handing off to chat. Without it, a session
  // refresh fired during the hatch window leaves `sessionStatus` stuck at
  // "unauthenticated", hiding auth-gated UI (the Preferences menu) until a
  // full reload. The hatch flow must drive the same `connectLocalAssistant`
  // primitive the returning-user connect path uses.
  test("local hatch establishes the authenticated session via connectLocalAssistant", async () => {
    isLocalModeValue = true;
    localGatewayUrlValue = "http://127.0.0.1:7821";
    searchParams = new URLSearchParams("hosting=local");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
    })) as unknown as typeof fetch;

    try {
      render(<HatchingScreen />);

      await waitFor(
        () => expect(connectLocalAssistantMock).toHaveBeenCalledWith("local-1"),
        { timeout: 5_000 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("hatching persists the random avatar and invalidates the avatar query before leaving onboarding", async () => {
    // Route through the hatch + poll path (a freshly provisioned assistant),
    // not the already-active early return — only a fresh hatch may be seeded.
    let assistantCalls = 0;
    getAssistantImpl = async () =>
      assistantResult(++assistantCalls === 1 ? "initializing" : "active");

    let resolveLifecycle!: () => void;
    checkAssistantImpl = () =>
      new Promise<void>((resolve) => {
        resolveLifecycle = resolve;
      });

    render(<HatchingScreen />);

    await waitFor(() =>
      expect(saveCharacterTraitsMock).toHaveBeenCalledWith("asst-1", {
        bodyShape: "round",
        eyeStyle: "dot",
        color: "green",
      }),
    );
    await waitFor(() =>
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["assistantAvatar", "asst-1"],
      }),
    );

    // Persisting the avatar must not block the lifecycle hand-off.
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    resolveLifecycle();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
        replace: true,
      }),
    );
  });

  test("an already-active assistant (returning user) is not re-seeded with a random avatar", async () => {
    // getAssistantImpl defaults to active → the early-return path. A returning
    // user's avatar must be left untouched: an image avatar has no traits
    // sidecar, so seeding would overwrite it (see persistHatchAvatar).
    render(<HatchingScreen />);

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  test("a returning user whose pre-flight check fails transiently is not re-seeded via the poll path", async () => {
    // The early-return guard relies on a pre-flight getAssistant(); when that
    // throws transiently, the flow falls through to hatch + poll. hatchAssistant
    // then returns 200 (an existing assistant, not a fresh 201 creation), so the
    // poll path must NOT seed a random avatar over the returning user's avatar.
    let assistantCalls = 0;
    getAssistantImpl = async () => {
      assistantCalls += 1;
      if (assistantCalls === 1) throw new Error("transient pre-flight failure");
      return assistantResult("active");
    };
    hatchAssistantMock.mockResolvedValueOnce(assistantResult("active"));

    render(<HatchingScreen />);

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  test("a fresh hatch is still seeded when the hatch response is lost (pre-flight saw no assistant)", async () => {
    // Pre-flight resolves auto_hatch (HTTP 404 = no assistant existed), so the
    // user is provably new. hatchAssistant then throws (POST accepted, response
    // lost), so createdFreshAssistant never gets set — but the poll discovers
    // the freshly-created assistant, which must still be seeded rather than
    // landing on the default avatar.
    let assistantCalls = 0;
    getAssistantImpl = async () => {
      assistantCalls += 1;
      if (assistantCalls === 1) return { ok: false, status: 404, error: {} };
      return assistantResult("active");
    };
    hatchAssistantMock.mockImplementationOnce(async () => {
      throw new Error("response lost");
    });

    render(<HatchingScreen />);

    await waitFor(() =>
      expect(saveCharacterTraitsMock).toHaveBeenCalledWith("asst-1", {
        bodyShape: "round",
        eyeStyle: "dot",
        color: "green",
      }),
    );
    await waitFor(() =>
      expect(invalidateQueriesMock).toHaveBeenCalledWith({
        queryKey: ["assistantAvatar", "asst-1"],
      }),
    );
  });
});
