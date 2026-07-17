/**
 * Route-level regression tests for the research-onboarding resume guard.
 *
 * The established-assistant guard used to run only on form submit; a restored
 * post-form snapshot (persisted before the verdict settled, or after a transient
 * fail-open) re-fired the research turn via the mid-flow resume effect with NO
 * established check, silently re-onboarding an assistant that already had a life.
 * These tests pin the fix: a restored post-form journey consults the guard first
 * and diverts to the keep/redo decision screen when established, while a fresh
 * assistant resumes exactly as before. A form-submit case guards the shared-gate
 * refactor.
 *
 * Self-contained mocks (run this file solo — `mock.module` leaks across a shared
 * `bun test` run).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode } from "react";

import {
  writeResearchSnapshot,
  type ResearchOnboardingSnapshot,
} from "@/domains/onboarding/research-onboarding-persistence";

const USER_ID = "user-1";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
const searchParams = new URLSearchParams();

const startResearchMock = mock((_opts: unknown) => {});
const hydrateResearchMock = mock((_results: unknown, _await?: unknown) => {});
let researchStatus = "idle";
const researchRunner = {
  get status() {
    return researchStatus;
  },
  claims: [] as unknown[],
  droppedClaims: [] as string[],
  suggestions: [] as unknown[],
  installedPlugins: [] as string[],
  pluginCatalog: {} as Record<string, string>,
  start: startResearchMock,
  hydrate: hydrateResearchMock,
  awaitPluginInstalls: async () => {},
};

let establishedResult: { established: boolean; assistantName: string | null } =
  {
    established: false,
    assistantName: null,
  };
const checkEstablishedAssistantMock = mock(
  async (_id: string) => establishedResult,
);

const backgroundHatch = {
  start: () => {},
  ready: true,
  assistantId: "asst-1",
  error: null as Error | null,
  awaitReady: async () => "asst-1",
};

const noop = () => {};

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: async () => {},
    markExpectingFirstMessage: () => {},
  },
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthMode: () => false,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => false,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({ id: USER_ID, firstName: "Ada", lastName: "Lovelace" }),
    },
  },
}));

mock.module("@/utils/routes", () => ({
  routes: { assistant: "/assistant" },
}));

mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
}));

mock.module("@/domains/onboarding/prechat-names", () => ({
  DEFAULT_GROUP_ID: "default",
}));

mock.module("@/domains/onboarding/prechat", () => ({
  setPendingAssistantName: () => {},
  setPendingPreChatContext: () => {},
}));

mock.module("@/domains/onboarding/research-prompt", () => ({
  buildResearchPrompt: () => "research prompt",
}));

mock.module("@/domains/onboarding/adopt-existing-assistant", () => ({
  shouldAdoptExistingAssistant: () => false,
}));

mock.module("@/domains/onboarding/use-background-hatch", () => ({
  useBackgroundHatch: () => backgroundHatch,
}));

mock.module("@/domains/onboarding/research-runner", () => ({
  useResearchRunner: () => researchRunner,
}));

mock.module("@/domains/onboarding/send-research-correction", () => ({
  sendResearchCorrection: async () => {},
}));

mock.module("@/domains/onboarding/apply-personality", () => ({
  applyPersonality: async () => {},
}));

mock.module("@/domains/onboarding/lets-chat-kickoff", () => ({
  buildLetsChatKickoffMessage: () => "kickoff",
}));

mock.module("@/domains/onboarding/funnel-events", () => ({
  emitResearchOnboardingStepCompleted: () => {},
  RESEARCH_ONBOARDING_FUNNEL_STEPS: new Proxy(
    {},
    { get: () => ({ stepName: "step", stepIndex: 0 }) },
  ),
}));

mock.module("@/domains/onboarding/checkin-scheduler", () => ({
  scheduleCheckin: async () => ({ scheduled: false }),
}));

mock.module("@/domains/onboarding/hooks/use-google-calendar-connect", () => ({
  GOOGLE_CALENDAR_EVENTS_SCOPE:
    "https://www.googleapis.com/auth/calendar.events",
}));

mock.module("@/domains/onboarding/format-checkin-time", () => ({
  formatCheckinTime: () => "2:30 PM",
}));

mock.module("@/utils/browser-timezone", () => ({
  getBrowserTimezone: () => "UTC",
}));

mock.module("@/stores/onboarding-focus-store", () => ({
  useOnboardingFocusStore: {
    use: {
      enterFocus: () => noop,
      exitFocus: () => noop,
      setPendingAvatarTraits: () => noop,
      requestSidebarCollapse: () => noop,
    },
  },
}));

mock.module("@/domains/onboarding/established-assistant", () => ({
  checkEstablishedAssistant: checkEstablishedAssistantMock,
  FRESH_ASSISTANT_CHECK: { established: false, assistantName: null },
}));

mock.module("@/domains/onboarding/screens/research-onboarding-screen", () => ({
  ResearchOnboardingScreen: (props: {
    onSubmit: (values: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="form-submit"
      onClick={() =>
        props.onSubmit({
          firstName: "Ada",
          lastName: "Lovelace",
          role: "Engineer",
          hobbies: [],
        })
      }
    >
      submit
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/give-me-a-face-screen", () => ({
  GiveMeAFaceScreen: () => <div data-testid="face-step" />,
}));

mock.module("@/domains/onboarding/screens/introduction-screen", () => ({
  IntroductionScreen: () => <div data-testid="intro-step" />,
}));

mock.module("@/domains/onboarding/screens/intro-pitch-steps", () => ({
  PitchStep: () => <div data-testid="pitch-step" />,
}));

mock.module("@/domains/onboarding/screens/integration-step", () => ({
  IntegrationStep: () => <div data-testid="integration-step" />,
}));

mock.module("@/domains/onboarding/screens/create-personality-step", () => ({
  CreatePersonalityStep: () => <div data-testid="personality-step" />,
}));

mock.module("@/domains/onboarding/screens/lets-chat-tomorrow-step", () => ({
  LetsChatTomorrowStep: () => <div data-testid="letschat-step" />,
}));

mock.module("@/domains/onboarding/screens/research-result-steps", () => ({
  MeetingCreatedStep: () => <div data-testid="meeting-step" />,
  LookingYouUpStep: () => <div data-testid="looking-step" />,
  FinishingUpStep: () => <div data-testid="finishing-step" />,
  ResearchResultsStep: () => <div data-testid="results-step" />,
  SuggestionsStep: () => <div data-testid="suggestions-step" />,
  LetsChatReadyStep: () => <div data-testid="letschat-ready-step" />,
}));

mock.module("@/domains/onboarding/screens/existing-assistant-step", () => ({
  ExistingAssistantStep: (props: { assistantName: string | null }) => (
    <div data-testid="existing-step">{props.assistantName ?? "unknown"}</div>
  ),
}));

mock.module(
  "@/domains/onboarding/components/onboarding-toned-backdrop",
  () => ({
    OnboardingTonedBackdrop: () => <div data-testid="toned-backdrop" />,
  }),
);

mock.module("@/domains/onboarding/hooks/use-onboarding-stage-size", () => ({
  OnboardingStageSizeProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  useElementSize: () => ({
    ref: { current: null },
    size: { width: 0, height: 0 },
  }),
}));

const { ResearchOnboardingRoute } =
  await import("@/domains/onboarding/pages/research-onboarding-route");

function postFormSnapshot(
  overrides: Partial<ResearchOnboardingSnapshot> = {},
): ResearchOnboardingSnapshot {
  return {
    step: "looking",
    formValues: {
      firstName: "Ada",
      lastName: "Lovelace",
      role: "Engineer",
      hobbies: ["chess"],
    },
    faceValues: null,
    checkinTime: null,
    checkinBooked: false,
    research: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  researchStatus = "idle";
  establishedResult = { established: false, assistantName: null };
  navigateMock.mockClear();
  startResearchMock.mockClear();
  hydrateResearchMock.mockClear();
  checkEstablishedAssistantMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ResearchOnboardingRoute resume guard", () => {
  test("a restored post-form snapshot diverts to the decision screen when the assistant is established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    writeResearchSnapshot(USER_ID, postFormSnapshot());

    render(<ResearchOnboardingRoute />);

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    // Named for the assistant it protects, and — the crux of the fix — the
    // research turn was never re-fired against the established assistant.
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("a restored post-form snapshot resumes research when the assistant is fresh", async () => {
    establishedResult = { established: false, assistantName: null };
    writeResearchSnapshot(USER_ID, postFormSnapshot());

    render(<ResearchOnboardingRoute />);

    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));
    // No guard flash for a genuinely-new assistant; it resumes mid-flow.
    expect(screen.queryByTestId("existing-step")).toBeNull();
    expect(screen.getByTestId("looking-step")).toBeTruthy();
  });

  test("submitting the form still diverts to the decision screen when established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    // No snapshot: a fresh visit lands on the form.
    render(<ResearchOnboardingRoute />);

    fireEvent.click(await screen.findByTestId("form-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });
});
