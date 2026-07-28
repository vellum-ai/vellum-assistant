/**
 * Route-level regression tests for the research-onboarding resume guard and the
 * paid-checkout return.
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
 * They also cover the two follow-ups from Codex on #38405: the guard runs for a
 * snapshot hydrated straight to "done" (not just an idle one), and parking on
 * the guard from a resume never persists a resumable `step: "existing"` snapshot
 * — so a refresh re-lands on the keep/redo choice instead of auto-resuming past
 * it.
 *
 * The paid-return block covers the `post_checkout=1` marker reaching the
 * background hatch and the failure overlay that surfaces a dead hatch on any
 * step, with the at-capacity download off-ramp in place of a retry. The retry
 * block covers what that overlay's "Try again" has to un-poison: route state
 * that resolved against the dead hatch and would otherwise survive the retry.
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

import { PLATFORM_HOSTED_DISABLED_MESSAGE } from "@/assistant/lifecycle";
import {
  readResearchSnapshot,
  writeResearchSnapshot,
  type ResearchOnboardingSnapshot,
} from "@/domains/onboarding/research-onboarding-persistence";

const USER_ID = "user-1";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
const searchParams = new URLSearchParams();

let researchStatus = "idle";
// Mirrors the real runner, which flips to "running" synchronously inside
// `start` — that is what keeps the mid-flow resume effect from firing a second
// turn behind a form submit.
const startResearchMock = mock((_opts: unknown) => {
  researchStatus = "running";
});
const hydrateResearchMock = mock((_results: unknown, _await?: unknown) => {});
const resetResearchMock = mock(() => {});
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
  reset: resetResearchMock,
  awaitPluginInstalls: async () => {},
};

let establishedResult: { established: boolean; assistantName: string | null } =
  {
    established: false,
    assistantName: null,
  };
// When armed, the established-assistant check blocks on this gate so a test can
// hold the verdict — exercising the window where the resumed terminal step is
// already on screen but the guard hasn't settled — then release it on demand.
let establishedCheckGate: Promise<void> | null = null;
let releaseEstablishedCheck: () => void = () => {};
function armDelayedEstablishedCheck() {
  establishedCheckGate = new Promise<void>((resolve) => {
    releaseEstablishedCheck = resolve;
  });
}
const checkEstablishedAssistantMock = mock(async (_id: string) => {
  if (establishedCheckGate) {
    await establishedCheckGate;
  }
  return establishedResult;
});

// The hatch's readiness promise is swapped per test (a dead first attempt
// rejects; the retry hands back a healthy one), and `onRetryHatch` is where a
// test stages that recovery — it runs inside the overlay's click, exactly where
// the real `retry()` would clear the hook's terminal state.
let awaitHatchReady: () => Promise<string> = async () => "asst-1";
let onRetryHatch: () => void = () => {};
const retryHatchMock = mock(() => {
  onRetryHatch();
});
const backgroundHatch = {
  start: () => {},
  retry: retryHatchMock,
  ready: true,
  assistantId: "asst-1",
  error: null as string | null,
  awaitReady: () => awaitHatchReady(),
};
const useBackgroundHatchMock = mock(
  (_options: { postCheckoutReturn?: boolean }) => backgroundHatch,
);

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

// The real module builds its destinations from `routes` at import time, and the
// `@/utils/routes` stub below carries only the assistant path.
mock.module("@/lib/navigation/navigation-resolver", () => ({
  POST_CHECKOUT_HATCH_PARAM: "post_checkout",
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
  useBackgroundHatch: useBackgroundHatchMock,
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
  // Renders the real step's contract: a "Let's chat" CTA that the parent can
  // hold via `disabled`. Mirrors the component's own guard (native disable +
  // the handleStart no-op) so a disabled CTA can't fire the handoff.
  LetsChatReadyStep: (props: {
    onStart: () => void | Promise<void>;
    disabled?: boolean;
  }) => (
    <div data-testid="letschat-ready-step">
      <button
        type="button"
        data-testid="letschat-start"
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) {
            return;
          }
          void props.onStart();
        }}
      >
        Let&apos;s chat
      </button>
    </div>
  ),
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
  establishedCheckGate = null;
  releaseEstablishedCheck = () => {};
  searchParams.delete("post_checkout");
  backgroundHatch.error = null;
  awaitHatchReady = async () => "asst-1";
  onRetryHatch = () => {};
  navigateMock.mockClear();
  startResearchMock.mockClear();
  hydrateResearchMock.mockClear();
  resetResearchMock.mockClear();
  checkEstablishedAssistantMock.mockClear();
  useBackgroundHatchMock.mockClear();
  retryHatchMock.mockClear();
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

  // A completed snapshot hydrates the runner to "done" and resolveResumeStep
  // lands it on the suggestions step. That is NOT idle, so the pre-fix resume
  // effect returned early and never consulted the guard — the user could walk a
  // done journey into the chat handoff against an established assistant.
  const doneSnapshot = (): ResearchOnboardingSnapshot =>
    postFormSnapshot({
      step: "suggestions",
      research: {
        status: "done",
        claims: [],
        droppedClaims: [],
        suggestions: [],
        installedPlugins: [],
        pluginCatalog: {},
      },
    });

  test("a restored completed snapshot diverts to the decision screen when the assistant is established", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    researchStatus = "done";
    writeResearchSnapshot(USER_ID, doneSnapshot());

    render(<ResearchOnboardingRoute />);

    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    // A hydrated "done" journey never re-fires research either way.
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("a restored completed snapshot resumes without the guard when the assistant is fresh", async () => {
    establishedResult = { established: false, assistantName: null };
    researchStatus = "done";
    writeResearchSnapshot(USER_ID, doneSnapshot());

    render(<ResearchOnboardingRoute />);

    // personalityEnabled → the suggestions step renders the "Let's chat" screen.
    await waitFor(() =>
      expect(screen.getByTestId("letschat-ready-step")).toBeTruthy(),
    );
    // A fresh verdict must not divert, and a done journey never re-fires.
    expect(screen.queryByTestId("existing-step")).toBeNull();
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  // The completed snapshot lands on the terminal handoff synchronously, but the
  // established check settles asynchronously. Until the verdict lands the "Let's
  // chat" CTA must stay held — otherwise a click races past the guard, clears
  // the snapshot, and navigates away before `setStep("existing")` can divert.
  test("holds the 'Let's chat' handoff while a resumed done journey awaits the guard, then diverts when established", async () => {
    armDelayedEstablishedCheck();
    establishedResult = { established: true, assistantName: "Viper" };
    researchStatus = "done";
    writeResearchSnapshot(USER_ID, doneSnapshot());

    render(<ResearchOnboardingRoute />);

    // The terminal step is on screen, but the guard hasn't settled → CTA held.
    await waitFor(() =>
      expect(screen.getByTestId("letschat-start")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("letschat-start") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Clicking the held CTA does nothing: no handoff navigation, snapshot intact.
    fireEvent.click(screen.getByTestId("letschat-start"));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(readResearchSnapshot(USER_ID)).not.toBeNull();

    // Releasing an established verdict still diverts to the keep/redo screen.
    releaseEstablishedCheck();
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(screen.getByTestId("existing-step").textContent).toBe("Viper");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("releases the held handoff once a resumed done journey's guard resolves fresh", async () => {
    armDelayedEstablishedCheck();
    establishedResult = { established: false, assistantName: null };
    researchStatus = "done";
    writeResearchSnapshot(USER_ID, doneSnapshot());

    render(<ResearchOnboardingRoute />);

    // Held while the verdict is pending.
    await waitFor(() =>
      expect(screen.getByTestId("letschat-start")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("letschat-start") as HTMLButtonElement).disabled,
    ).toBe(true);

    // A fresh verdict releases the hold — no divert, and the CTA becomes usable.
    releaseEstablishedCheck();
    await waitFor(() =>
      expect(
        (screen.getByTestId("letschat-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByTestId("existing-step")).toBeNull();

    // And now clicking it actually hands off to the chat.
    fireEvent.click(screen.getByTestId("letschat-start"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("parking on the guard from a resume never persists a resumable 'existing' snapshot", async () => {
    establishedResult = { established: true, assistantName: "Viper" };
    writeResearchSnapshot(USER_ID, postFormSnapshot());

    render(<ResearchOnboardingRoute />);
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );

    // The parked-on-guard journey clears formValues, so the persistence effect
    // can't write a `step: "existing"` snapshot carrying post-form values — the
    // persisted step stays the pre-guard one.
    expect(readResearchSnapshot(USER_ID)?.step).not.toBe("existing");

    // A refresh (fresh mount, same snapshot) re-lands on the keep/redo choice
    // rather than auto-resuming past the guard.
    cleanup();
    render(<ResearchOnboardingRoute />);
    await waitFor(() =>
      expect(screen.getByTestId("existing-step")).toBeTruthy(),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });
});

describe("ResearchOnboardingRoute paid return", () => {
  function lastHatchOptions() {
    const call = useBackgroundHatchMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected useBackgroundHatch to have been called");
    }
    return call[0];
  }

  test("carries the paid marker into the background hatch", async () => {
    searchParams.set("post_checkout", "1");

    render(<ResearchOnboardingRoute />);
    await screen.findByTestId("form-submit");

    expect(lastHatchOptions().postCheckoutReturn).toBe(true);
  });

  test("a free onboarding leaves the purchased-provisioning wait off", async () => {
    render(<ResearchOnboardingRoute />);
    await screen.findByTestId("form-submit");

    expect(lastHatchOptions().postCheckoutReturn).toBe(false);
  });

  test("a terminal hatch failure surfaces a retry over the funnel", async () => {
    backgroundHatch.error = "Failed to start your assistant. Please try again.";

    render(<ResearchOnboardingRoute />);

    const overlay = await screen.findByRole("alertdialog");
    expect(overlay.textContent).toContain(
      "Failed to start your assistant. Please try again.",
    );
    // Layered, not swapped in: the funnel keeps its state behind the overlay.
    expect(screen.getByTestId("form-submit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryHatchMock).toHaveBeenCalledTimes(1);
  });

  test("an at-capacity failure offers the macOS download instead of a retry", async () => {
    backgroundHatch.error = PLATFORM_HOSTED_DISABLED_MESSAGE;

    render(<ResearchOnboardingRoute />);

    const overlay = await screen.findByRole("alertdialog");
    expect(overlay.textContent).toContain(
      "Get started today with a local assistant",
    );
    expect(
      screen.getByRole("link", { name: "Download the macOS app" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("a healthy hatch renders no overlay", async () => {
    render(<ResearchOnboardingRoute />);
    await screen.findByTestId("form-submit");

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// Retrying the hatch has to restart everything that already resolved against
// the dead one. Both of these used to survive the retry poisoned: the
// established-assistant verdict (cached fail-open from the rejected
// `awaitReady`) and a research turn that settled "error" while keeping its
// subject key, which made even an identical resubmit a no-op.
describe("ResearchOnboardingRoute hatch retry", () => {
  const HATCH_ERROR = "Failed to start your assistant. Please try again.";

  function failFirstHatch() {
    backgroundHatch.error = HATCH_ERROR;
    awaitHatchReady = () => Promise.reject(new Error("hatch failed"));
  }

  function recoverOnRetry() {
    onRetryHatch = () => {
      backgroundHatch.error = null;
      awaitHatchReady = async () => "asst-1";
    };
  }

  test("re-runs the established-assistant check against the retried hatch", async () => {
    failFirstHatch();
    // The retry recovers an assistant that already has a life.
    establishedResult = { established: true, assistantName: "Viper" };

    render(<ResearchOnboardingRoute />);
    await screen.findByRole("alertdialog");
    // The dead hatch never got far enough to ask.
    expect(checkEstablishedAssistantMock).not.toHaveBeenCalled();

    recoverOnRetry();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    fireEvent.click(screen.getByTestId("form-submit"));

    // The gate recomputed against the new attempt, so the submit lands on the
    // keep/redo choice instead of running research + persona writes against an
    // established assistant.
    await waitFor(() =>
      expect(screen.getByTestId("existing-step").textContent).toBe("Viper"),
    );
    expect(startResearchMock).not.toHaveBeenCalled();
  });

  test("re-fires a research turn that died with the hatch", async () => {
    const { rerender } = render(<ResearchOnboardingRoute />);
    fireEvent.click(await screen.findByTestId("form-submit"));
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));

    // The hatch dies after the submit: the runner's `awaitAssistantId` rejects
    // and the turn settles "error", still holding the submitted subject key.
    researchStatus = "error";
    backgroundHatch.error = HATCH_ERROR;
    rerender(<ResearchOnboardingRoute />);

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(resetResearchMock).toHaveBeenCalledTimes(1);
    expect(startResearchMock).toHaveBeenCalledTimes(2);
    // Ordering stays the runner's job: the re-fired turn awaits the retried
    // hatch itself rather than the handler awaiting readiness first.
    const refired = startResearchMock.mock.calls[1]?.[0] as {
      awaitAssistantId: () => Promise<string>;
    };
    expect(refired.awaitAssistantId).toBe(backgroundHatch.awaitReady);
  });

  test("does not re-fire a research turn that never errored", async () => {
    const { rerender } = render(<ResearchOnboardingRoute />);
    fireEvent.click(await screen.findByTestId("form-submit"));
    await waitFor(() => expect(startResearchMock).toHaveBeenCalledTimes(1));

    // Still running when the hatch failed — the turn is already parked on the
    // runner's own `awaitAssistantId`, so a retry must not double-fire it.
    backgroundHatch.error = HATCH_ERROR;
    rerender(<ResearchOnboardingRoute />);

    recoverOnRetry();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(resetResearchMock).not.toHaveBeenCalled();
    expect(startResearchMock).toHaveBeenCalledTimes(1);
  });
});
