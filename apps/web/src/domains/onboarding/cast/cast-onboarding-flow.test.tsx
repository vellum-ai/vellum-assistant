/**
 * Tests for the cast onboarding flow's handoff (early-research-send architecture):
 *   - login-phase entry starts the background hatch
 *   - finishing the login/role step fires the research send (name + role +
 *     directive) once the hatch is ready
 *   - completion lands the user in the research conversation, after ensuring the
 *     hatched assistant is selected + present in the resolved store (so the
 *     route guard doesn't bounce back to onboarding)
 *   - completion awaits hatch readiness before navigating
 *   - a terminal hatch failure surfaces a retry affordance instead of navigating
 *
 * Heavy cast screens are mocked down to single buttons so the test can drive
 * the phase machine deterministically. The background hatch, research send,
 * lifecycle, store, and navigation are all mocked so we assert the
 * orchestration without real I/O.
 *
 * Single-file `bun test` — multi-file runs leak `mock.module` across files.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { CAST_RESEARCH_DIRECTIVE } from "@/domains/onboarding/cast/cast-prechat-mapping";

// --- background hatch --------------------------------------------------------
const startMock = mock(() => {});
let awaitReadyImpl: () => Promise<string> = async () => "asst-ready";
const awaitReadyMock = mock(() => awaitReadyImpl());

mock.module("@/domains/onboarding/cast/use-background-hatch", () => ({
  useBackgroundHatch: () => ({
    start: startMock,
    ready: false,
    assistantId: null,
    error: null,
    awaitReady: awaitReadyMock,
  }),
}));

// --- research send -----------------------------------------------------------
let sendImpl: () => Promise<string> = async () => "conv-1";
const sendResearchMock = mock((..._args: unknown[]) => sendImpl());
mock.module("@/domains/onboarding/cast/send-research-message", () => ({
  sendCastResearchMessage: sendResearchMock,
}));

// --- prechat (optimistic pending name) --------------------------------------
const setPendingAssistantNameMock = mock((_name: string) => {});
mock.module("@/domains/onboarding/prechat", () => ({
  setPendingAssistantName: setPendingAssistantNameMock,
}));

// --- assistant api / lifecycle / selection / store --------------------------
const getAssistantMock = mock(async (_id?: string) => ({
  ok: true as const,
  status: 200,
  data: { id: "asst-ready", name: "Pixel", is_local: false, created: "2026-01-01" },
}));
mock.module("@/assistant/api", () => ({ getAssistant: getAssistantMock }));

const checkAssistantMock = mock(async (_assistantId?: string) => {});
mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: { checkAssistant: checkAssistantMock },
}));

const setSelectedAssistantMock = mock(async (_id: string) => {});
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

const setActiveAssistantIdMock = mock((_id: string) => {});
const upsertFromApiMock = mock((_a: unknown) => {});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      setActiveAssistantId: setActiveAssistantIdMock,
      upsertFromApi: upsertFromApiMock,
    }),
  },
}));

// --- portal provider (passthrough) ------------------------------------------
mock.module("@vellumai/design-library/utils/portal-container", () => ({
  PortalContainerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// --- auth store (only `user` is read for the funnel userId) -----------------
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
}));

// --- navigation --------------------------------------------------------------
const navigateMock = mock(() => {});
const setSearchParamsMock = mock(() => {});
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, setSearchParamsMock] as const,
}));

// --- cast screens (driven via testid buttons) --------------------------------
mock.module("@/domains/onboarding/cast/cast.css", () => ({}));

mock.module("@/domains/onboarding/cast/cast-shell", () => ({
  SetupShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MemoryList: () => null,
}));

mock.module("@/domains/onboarding/cast/screens/login-screen", () => ({
  LoginScreen: ({
    onAdvance,
    onContinue,
    onIdentity,
  }: {
    onAdvance: () => void;
    onContinue: (fn: string) => void;
    onIdentity?: (id: {
      firstName: string;
      lastName: string;
      role: string;
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="login-continue"
      onClick={() => {
        onContinue("Alice");
        onIdentity?.({
          firstName: "Alice",
          lastName: "Example",
          role: "Software Engineer",
        });
        onAdvance();
      }}
    >
      login
    </button>
  ),
}));

mock.module("@/domains/onboarding/cast/screens/preamble-screen", () => ({
  PreambleScreen: ({ onAdvance }: { onAdvance: () => void }) => (
    <button type="button" data-testid="preamble-continue" onClick={onAdvance}>
      preamble
    </button>
  ),
}));

const FAKE_CHARACTER = {
  id: "cast-1",
  name: "Pixel",
  bodyShape: "round",
  eyeStyle: "dot",
  color: "blue",
};

mock.module("@/domains/onboarding/cast/screens/starter-screen", () => ({
  StarterScreen: ({
    onChoose,
  }: {
    onChoose: (c: typeof FAKE_CHARACTER, name: string) => void;
  }) => (
    <button
      type="button"
      data-testid="starter-choose"
      onClick={() => onChoose(FAKE_CHARACTER, "Pixel")}
    >
      starter
    </button>
  ),
}));

mock.module("@/domains/onboarding/cast/screens/dialogue-screen", () => ({
  DialogueScreen: ({ onAdvance }: { onAdvance: () => void }) => (
    <button type="button" data-testid="dialogue-complete" onClick={onAdvance}>
      dialogue
    </button>
  ),
}));

mock.module("@/domains/onboarding/cast/screens/style-screen", () => ({
  StyleScreen: () => null,
}));

mock.module("@/domains/onboarding/cast/screens/done-screen", () => ({
  DoneScreen: () => null,
}));

const { CastOnboardingFlow } = await import(
  "@/domains/onboarding/cast/cast-onboarding-flow"
);

function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Walk login -> preamble -> starter -> dialogue completion. */
async function completeFlow(): Promise<void> {
  fireEvent.click(await screen.findByTestId("login-continue"));
  fireEvent.click(await screen.findByTestId("preamble-continue"));
  fireEvent.click(await screen.findByTestId("starter-choose"));
  fireEvent.click(await screen.findByTestId("dialogue-complete"));
}

beforeEach(() => {
  searchParamsValue = new URLSearchParams();
  awaitReadyImpl = async () => "asst-ready";
  sendImpl = async () => "conv-1";
  startMock.mockClear();
  awaitReadyMock.mockClear();
  sendResearchMock.mockClear();
  setPendingAssistantNameMock.mockClear();
  getAssistantMock.mockClear();
  checkAssistantMock.mockClear();
  setSelectedAssistantMock.mockClear();
  setActiveAssistantIdMock.mockClear();
  upsertFromApiMock.mockClear();
  navigateMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CastOnboardingFlow handoff", () => {
  test("entering the login phase starts the hatch", async () => {
    render(<CastOnboardingFlow />);
    await screen.findByTestId("login-continue");
    expect(startMock).toHaveBeenCalled();
  });

  test("finishing the login step sends the research directive with occupation", async () => {
    render(<CastOnboardingFlow />);
    fireEvent.click(await screen.findByTestId("login-continue"));

    await waitFor(() => expect(sendResearchMock).toHaveBeenCalledTimes(1));
    const [assistantId, message, context] = sendResearchMock.mock.calls[0]!;
    expect(assistantId).toBe("asst-ready");
    expect(message).toBe(CAST_RESEARCH_DIRECTIVE);
    expect((context as { occupation?: string }).occupation).toBe(
      "Software Engineer",
    );
  });

  test("completion lands the user in the research conversation", async () => {
    render(<CastOnboardingFlow />);
    await completeFlow();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        expect.stringContaining("conv-1"),
        { replace: true },
      ),
    );
    // The hatched assistant is selected AND upserted before nav, so the route
    // guard sees `hasAssistants` and doesn't bounce back to onboarding.
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith("asst-ready");
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("asst-ready");
    expect(upsertFromApiMock).toHaveBeenCalledTimes(1);
    expect(setPendingAssistantNameMock).toHaveBeenCalledWith("Pixel");
  });

  test("completion awaits hatch readiness before navigating", async () => {
    let resolveReady!: (id: string) => void;
    awaitReadyImpl = () =>
      new Promise<string>((resolve) => {
        resolveReady = resolve;
      });

    render(<CastOnboardingFlow />);
    await completeFlow();

    // Readiness still pending: nothing sent or navigated yet.
    await drainMicrotasks();
    expect(sendResearchMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    resolveReady("asst-ready");

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith("asst-ready");
  });

  test("terminal hatch failure surfaces retry rather than navigating", async () => {
    awaitReadyImpl = async () => {
      throw new Error("Failed to start your assistant. Please try again.");
    };

    render(<CastOnboardingFlow />);
    await completeFlow();

    await screen.findByRole("alert");
    expect(navigateMock).not.toHaveBeenCalled();

    // Retrying re-arms the hatch and, once it succeeds, completes the handoff.
    awaitReadyImpl = async () => "asst-retry";
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith("asst-retry");
  });

  // -- preview mode: purely visual, zero side effects -------------------------

  test("preview does not start the background hatch on login-phase entry", async () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<CastOnboardingFlow />);
    await screen.findByTestId("login-continue");
    expect(startMock).not.toHaveBeenCalled();
  });

  test("preview runs no handoff on completion (no send, no nav)", async () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<CastOnboardingFlow />);
    await completeFlow();
    await drainMicrotasks();

    expect(startMock).not.toHaveBeenCalled();
    expect(awaitReadyMock).not.toHaveBeenCalled();
    expect(sendResearchMock).not.toHaveBeenCalled();
    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
