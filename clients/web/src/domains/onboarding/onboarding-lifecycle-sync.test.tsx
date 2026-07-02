import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useState, type ReactNode } from "react";

import {
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
  STORAGE_KEY,
} from "@/domains/onboarding/prechat";
import {
  ACTIVATION_FLOW_COHORT,
  ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
} from "@/domains/onboarding/prechat-context";
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

type TestOnboardingRecipe = {
  cohort: string;
  tasks: string[];
  tone: string;
  bootstrapTemplate: string;
  initialMessage: string;
  skills: string[];
  skipPrechat: boolean;
};

let preChatOnboardingExperiment = "variant-a";
let activationFlowExperiment = "control";
let selfIntroGreeting = true;
let isIOSWeb = false;
let isMacOSWeb = false;
let iosAppDownloaded = true;
let macOsAppDownloaded = true;
let isLocalModeValue = false;
let localGatewayUrlValue: string | undefined = undefined;
let platformSessionValue: PlatformSessionStatus = "absent";
let fetchOnboardingRecipeImpl: () => Promise<TestOnboardingRecipe | null> =
  async () => null;
const fetchOnboardingRecipeMock = mock(() => fetchOnboardingRecipeImpl());

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
  readShareAnalytics: () => true,
  readTosAccepted: () => true,
  writeSelectedVersion: writeSelectedVersionMock,
}));

mock.module("@/domains/onboarding/recipe-client.js", () => ({
  fetchOnboardingRecipe: fetchOnboardingRecipeMock,
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

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      stringFlags: () => ({
        preChatOnboardingExperiment20260606: preChatOnboardingExperiment,
        experimentActivationFlow20260603: activationFlowExperiment,
      }),
      selfIntroGreeting: () => selfIntroGreeting,
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

type EmulatedQueryOptions = {
  queryKey?: unknown[];
  queryFn?: () => Promise<unknown>;
  enabled?: boolean;
};

// The recipe query gates the whole pre-chat render, so emulate just enough of a
// real query (run the queryFn, track loading, honor `enabled`) to keep the
// loading-gate and "local mode never fetches" tests meaningful. Every other
// query in the tree (active assistant, OAuth connections) only needs canned
// data, so it takes the static return. The emulation state lives inline in the
// mock so the hooks run unconditionally on every `useQuery` call regardless of
// which query it is — only the returned value branches on the query key.
mock.module("@tanstack/react-query", () => ({
  useQuery: (options?: EmulatedQueryOptions) => {
    const isRecipeQuery =
      Array.isArray(options?.queryKey) &&
      options?.queryKey[0] === "onboarding-recipe";
    const enabled = isRecipeQuery && Boolean(options?.enabled);
    const [state, setState] = useState<{ data: unknown; isLoading: boolean }>(
      () => ({ data: undefined, isLoading: enabled }),
    );
    useEffect(() => {
      if (!enabled) {
        setState({ data: undefined, isLoading: false });
        return;
      }
      let cancelled = false;
      setState({ data: undefined, isLoading: true });
      void Promise.resolve(options?.queryFn?.()).then((data) => {
        if (!cancelled) setState({ data, isLoading: false });
      });
      return () => {
        cancelled = true;
      };
      // `options` is a fresh object every render; keying on `enabled` mirrors a
      // real query, which only refetches when its enabled-state flips.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);
    return isRecipeQuery ? state : { data: { id: "asst-1" } };
  },
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

mock.module("@/hooks/use-prefilled-input", () => ({
  usePrefilledInput: (initial: string) => ({
    value: initial,
    onChange: mock(() => {}),
  }),
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsIOSWeb: () => isIOSWeb,
  useIsMacOSWeb: () => isMacOSWeb,
  // `messages`/`research-runner` (pulled in transitively) import
  // `detectClientOs`; this onboarding test doesn't exercise the OS surface, so
  // stub the web default to keep the partial module mock complete.
  detectClientOs: () => "web",
}));

mock.module("@/hooks/use-ios-app-nudge", () => ({
  readIOSAppDownloaded: () => iosAppDownloaded,
}));

mock.module("@/hooks/use-macos-app-nudge", () => ({
  readMacOsAppDownloaded: () => macOsAppDownloaded,
}));

mock.module("@/domains/onboarding/screens/name-exchange-screen", () => ({
  NameExchangeScreen: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="name-continue" onClick={onComplete}>
      name
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/task-tone-selection-screen", () => ({
  TaskToneSelectionScreen: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" data-testid="task-continue" onClick={onContinue}>
      tasks
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/tool-selection-screen", () => ({
  ToolSelectionScreen: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" data-testid="tools-continue" onClick={onContinue}>
      tools
    </button>
  ),
}));

mock.module(
  "@/domains/onboarding/screens/prior-assistant-selection-screen",
  () => ({
    PriorAssistantSelectionScreen: ({
      onContinue,
    }: {
      onContinue: () => void;
    }) => (
      <button type="button" data-testid="prior-continue" onClick={onContinue}>
        prior assistants
      </button>
    ),
  }),
);

mock.module("@/domains/onboarding/screens/get-ios-app-screen", () => ({
  GetIOSAppScreen: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="ios-app-continue" onClick={onComplete}>
      iOS app
    </button>
  ),
}));

const { HatchingScreen } =
  await import("@/domains/onboarding/pages/hatching-screen");
const { PreChatFlow } =
  await import("@/domains/onboarding/pages/pre-chat-flow");

beforeEach(() => {
  searchParams = new URLSearchParams();
  checkAssistantImpl = async () => {};
  fetchTraitsImpl = async () => null;
  getAssistantImpl = async () => assistantResult("active");
  preChatOnboardingExperiment = "variant-a";
  activationFlowExperiment = "control";
  selfIntroGreeting = true;
  isIOSWeb = false;
  isMacOSWeb = false;
  iosAppDownloaded = true;
  macOsAppDownloaded = true;
  isLocalModeValue = false;
  localGatewayUrlValue = undefined;
  platformSessionValue = "absent";
  fetchOnboardingRecipeImpl = async () => null;
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
  fetchOnboardingRecipeMock.mockClear();
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
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat, {
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

  test("pre-chat completion refreshes the root assistant lifecycle before entering chat", async () => {
    let resolveLifecycle!: () => void;
    checkAssistantImpl = () =>
      new Promise<void>((resolve) => {
        resolveLifecycle = resolve;
      });

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    expect(await screen.findByText("Gmail")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    fireEvent.click(screen.getByText("Skip for now"));

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tools: [],
      tasks: [],
      tone: "grounded",
      userName: "Alice",
      googleConnected: false,
      initialMessage: "Hi, I'm Alice. Nice to meet you.",
    });

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    expect(navigateMock).not.toHaveBeenCalled();

    resolveLifecycle();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );
  });

  test("pre-chat uses the canned opener when self-intro greeting is off", async () => {
    selfIntroGreeting = false;

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    fireEvent.click(await screen.findByText("Skip for now"));

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tools: [],
      tasks: [],
      tone: "grounded",
      userName: "Alice",
      googleConnected: false,
      initialMessage: DEFAULT_PRECHAT_INITIAL_MESSAGE,
    });
  });

  test("activation flow flag selects the activation bootstrap after pre-chat", async () => {
    activationFlowExperiment = "variant-a";

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    fireEvent.click(await screen.findByText("Skip for now"));

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tools: [],
      tasks: [],
      tone: "grounded",
      userName: "Alice",
      googleConnected: false,
      cohort: ACTIVATION_FLOW_COHORT,
      initialMessage: "Hi, I'm Alice. Nice to meet you.",
      bootstrapTemplate: ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
    });
  });

  test("pre-chat keeps the existing full funnel when the v3 flag is off", async () => {
    preChatOnboardingExperiment = "control";

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));

    expect(await screen.findByTestId("task-continue")).toBeTruthy();
    expect(screen.queryByText("Connect Google")).toBeNull();
  });

  test("pre-chat control flow skips the macOS app step on macOS web", async () => {
    preChatOnboardingExperiment = "control";
    isMacOSWeb = true;
    macOsAppDownloaded = false;

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("task-continue"));
    fireEvent.click(await screen.findByTestId("tools-continue"));
    fireEvent.click(await screen.findByTestId("prior-continue"));

    expect(screen.queryByTestId("macos-app-continue")).toBeNull();
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );
  });

  test("pre-chat waits for the web recipe decision before showing standard screens", async () => {
    let resolveRecipe!: (recipe: TestOnboardingRecipe | null) => void;
    fetchOnboardingRecipeImpl = () =>
      new Promise<TestOnboardingRecipe | null>((resolve) => {
        resolveRecipe = resolve;
      });

    render(<PreChatFlow />);

    await waitFor(() => expect(fetchOnboardingRecipeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("name-continue")).toBeNull();

    resolveRecipe(null);

    expect(await screen.findByTestId("name-continue")).toBeTruthy();
  });

  test("recipe skip does not bypass the pared-down pre-chat screens", async () => {
    const recipe: TestOnboardingRecipe = {
      cohort: "content-automation",
      tasks: ["writing", "research"],
      tone: "grounded",
      bootstrapTemplate: "BOOTSTRAP-CONTENT-AUTOMATION.md",
      initialMessage: "I want to write articles that rank better in GEO",
      skills: ["content-automation"],
      skipPrechat: true,
    };
    fetchOnboardingRecipeImpl = async () => recipe;
    selfIntroGreeting = false;

    render(<PreChatFlow />);

    expect(await screen.findByTestId("name-continue")).toBeTruthy();
    expect(checkAssistantMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("name-continue"));
    expect(await screen.findByText("Gmail")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    fireEvent.click(screen.getByText("Skip for now"));

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tools: [],
      tasks: recipe.tasks,
      tone: recipe.tone,
      userName: "Alice",
      googleConnected: false,
      cohort: recipe.cohort,
      initialMessage: recipe.initialMessage,
      bootstrapTemplate: recipe.bootstrapTemplate,
      skills: recipe.skills,
    });
  });

  test("local mode never fetches the platform-only onboarding recipe", async () => {
    isLocalModeValue = true;

    render(<PreChatFlow />);

    expect(await screen.findByTestId("name-continue")).toBeTruthy();
    expect(fetchOnboardingRecipeMock).not.toHaveBeenCalled();
  });

  test("local mode without a platform session gates the prior-assistants step", async () => {
    preChatOnboardingExperiment = "control";
    isLocalModeValue = true;
    platformSessionValue = "absent";

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("task-continue"));
    fireEvent.click(await screen.findByTestId("tools-continue"));

    expect(screen.queryByTestId("prior-continue")).toBeNull();
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );
  });

  test("local mode with a platform session shows the prior-assistants step", async () => {
    preChatOnboardingExperiment = "control";
    isLocalModeValue = true;
    platformSessionValue = "present";

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("task-continue"));
    fireEvent.click(await screen.findByTestId("tools-continue"));

    expect(await screen.findByTestId("prior-continue")).toBeTruthy();
    expect(checkAssistantMock).not.toHaveBeenCalled();
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
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat, {
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
