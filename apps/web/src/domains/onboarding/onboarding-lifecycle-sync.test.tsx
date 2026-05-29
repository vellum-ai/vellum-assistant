import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { STORAGE_KEY } from "@/domains/onboarding/prechat";
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

const getAssistantMock = mock(async () => ({
  ok: true,
  status: 200,
  data: {
    id: "asst-1",
    status: "active",
    is_local: false,
    maintenance_mode: { enabled: false },
  },
}));

const fetchCharacterTraitsMock = mock(async () => null);
const saveCharacterTraitsMock = mock(async () => undefined);
const setOnboardingCompletedMock = mock(() => {});
const writeSelectedVersionMock = mock(() => {});
const markPrivacyConsentMock = mock(() => {});
const clearPrivacyConsentMock = mock(() => {});

type TestOnboardingRecipe = {
  cohort: string;
  tasks: string[];
  tone: string;
  bootstrapTemplate: string;
  initialMessage: string;
  skills: string[];
  skipPrechat: boolean;
};

let onboardingCompleted = false;
let prechatOnboardingCondensedFlow = true;
let fetchOnboardingRecipeImpl: () => Promise<TestOnboardingRecipe | null> =
  async () => null;
const fetchOnboardingRecipeMock = mock(() => fetchOnboardingRecipeImpl());

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/root-layout", () => ({
  useRootOutletContext: () => ({
    lifecycle: {
      checkAssistant: checkAssistantMock,
    },
  }),
}));

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  getAssistant: getAssistantMock,
}));

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterTraits: fetchCharacterTraitsMock,
  saveCharacterTraits: saveCharacterTraitsMock,
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

mock.module("@vellum/design-library/components/button", () => ({
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

mock.module("@vellum/design-library/components/progress-bar", () => ({
  ProgressBar: ({ value }: { value: number }) => (
    <div data-testid="progress" data-value={value} />
  ),
}));

mock.module("@sentry/browser", () => ({
  captureException: mock(() => {}),
  captureMessage: mock(() => {}),
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readAiDataConsent: () => true,
  readOnboardingCompleted: () => onboardingCompleted,
  readSelectedVersion: () => null,
  readShareAnalytics: () => true,
  readTosAccepted: () => true,
  clearOnboardingCompleted: mock(() => {}),
  useOnboardingCompleted: () =>
    [onboardingCompleted, setOnboardingCompletedMock] as const,
  writeSelectedVersion: writeSelectedVersionMock,
}));

mock.module("@/domains/onboarding/signals", () => ({
  clearPrivacyConsent: clearPrivacyConsentMock,
  hasRecentPrivacyConsent: () => true,
  markPrivacyConsent: markPrivacyConsentMock,
}));

mock.module("@/domains/onboarding/recipe-client.js", () => ({
  fetchOnboardingRecipe: fetchOnboardingRecipeMock,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  useIsNativePlatform: () => false,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => false,
  hasAssistants: () => false,
  getPlatformAssistants: () => [],
  getSelectedAssistant: () => undefined,
  hatchLocalAssistant: async () => ({ ok: true, assistantId: "local-1" }),
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  setSelectedAssistantId: () => {},
  saveLockfileAssistant: async () => {},
  primeLocalGatewayConnection: async () => {},
  getLocalGatewayUrl: () => undefined,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      prechatOnboardingCondensedFlow: () => prechatOnboardingCondensedFlow,
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
      isLoggedIn: () => true,
      isLoading: () => false,
      hasPlatformSession: () => false,
    },
  },
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      id: "asst-1",
    },
  }),
  useMutation: () => ({ mutate: mock(() => {}), isPending: false }),
  useQueryClient: () => ({ fetchQuery: mock(async () => []) }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsActiveRetrieveOptions: () => ({}),
  assistantsOauthConnectionsListOptions: () => ({}),
  assistantsOauthStartCreateMutation: () => ({}),
}));

mock.module("@/hooks/use-prefilled-input", () => ({
  usePrefilledInput: (initial: string) => ({
    value: initial,
    onChange: mock(() => {}),
  }),
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsIOSWeb: () => false,
  useIsMacOSWeb: () => false,
}));

mock.module("@/hooks/use-ios-app-nudge", () => ({
  readIOSAppDownloaded: () => true,
}));

mock.module("@/hooks/use-macos-app-nudge", () => ({
  readMacOsAppDownloaded: () => true,
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

mock.module("@/domains/onboarding/screens/prior-assistant-selection-screen", () => ({
  PriorAssistantSelectionScreen: ({
    onContinue,
  }: {
    onContinue: () => void;
  }) => (
    <button type="button" data-testid="prior-continue" onClick={onContinue}>
      prior assistants
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/get-ios-app-screen", () => ({
  GetIOSAppScreen: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="ios-app-continue" onClick={onComplete}>
      iOS app
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/get-macos-app-screen", () => ({
  GetMacOSAppScreen: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="macos-app-continue" onClick={onComplete}>
      macOS app
    </button>
  ),
}));

const { HatchingScreen } = await import(
  "@/domains/onboarding/pages/hatching-screen"
);
const { PreChatFlow } = await import(
  "@/domains/onboarding/pages/pre-chat-flow"
);

beforeEach(() => {
  searchParams = new URLSearchParams();
  checkAssistantImpl = async () => {};
  onboardingCompleted = false;
  prechatOnboardingCondensedFlow = true;
  fetchOnboardingRecipeImpl = async () => null;
  sessionStorage.clear();
  localStorage.clear();

  navigateMock.mockClear();
  checkAssistantMock.mockClear();
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  fetchCharacterTraitsMock.mockClear();
  saveCharacterTraitsMock.mockClear();
  setOnboardingCompletedMock.mockClear();
  writeSelectedVersionMock.mockClear();
  markPrivacyConsentMock.mockClear();
  clearPrivacyConsentMock.mockClear();
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

  test("hatching replay preserves the replay flag when onboarding is already completed", async () => {
    searchParams = new URLSearchParams("replay=1");
    onboardingCompleted = true;

    render(<HatchingScreen />);

    await waitFor(() => expect(getAssistantMock).toHaveBeenCalled());
    expect(hatchAssistantMock).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.onboarding.prechat}?replay=1`,
        { replace: true },
      ),
    );
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
      initialMessage: "Wake up, my friend!",
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

  test("pre-chat keeps the existing full funnel when the v3 flag is off", async () => {
    prechatOnboardingCondensedFlow = false;

    render(<PreChatFlow />);

    fireEvent.click(await screen.findByTestId("name-continue"));

    expect(await screen.findByTestId("task-continue")).toBeTruthy();
    expect(screen.queryByText("Connect Google")).toBeNull();
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

  test("recipe skip stores the pre-chat handoff and enters chat without showing pre-chat screens", async () => {
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

    render(<PreChatFlow />);

    expect(screen.queryByTestId("name-continue")).toBeNull();
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );

    expect(setOnboardingCompletedMock).toHaveBeenCalledWith(true);
    expect(clearPrivacyConsentMock).toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      tools: [],
      tasks: recipe.tasks,
      tone: recipe.tone,
      googleConnected: false,
      cohort: recipe.cohort,
      initialMessage: recipe.initialMessage,
      bootstrapTemplate: recipe.bootstrapTemplate,
      skills: recipe.skills,
    });
  });

  test("pre-chat replay ignores recipe skip so the standard screens are visible", async () => {
    searchParams = new URLSearchParams("replay=1");
    onboardingCompleted = true;
    fetchOnboardingRecipeImpl = async () => ({
      cohort: "content-automation",
      tasks: ["writing", "research"],
      tone: "grounded",
      bootstrapTemplate: "BOOTSTRAP-CONTENT-AUTOMATION.md",
      initialMessage: "I want to write articles that rank better in GEO",
      skills: ["content-automation"],
      skipPrechat: true,
    });

    render(<PreChatFlow />);

    await waitFor(() => expect(fetchOnboardingRecipeMock).toHaveBeenCalled());
    expect(await screen.findByTestId("name-continue")).toBeTruthy();
    expect(checkAssistantMock).not.toHaveBeenCalled();
  });
});
