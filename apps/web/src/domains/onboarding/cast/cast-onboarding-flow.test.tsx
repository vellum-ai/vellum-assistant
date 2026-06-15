/**
 * Tests for the cast onboarding flow's PR-6 handoff:
 *   - login-phase entry starts the background hatch exactly once
 *   - completion builds a PreChatOnboardingContext (occupation + research
 *     directive as initialMessage) and stashes it via setPendingPreChatContext
 *   - completion awaits hatch readiness before navigating
 *   - a terminal hatch failure surfaces a retry affordance instead of navigating
 *
 * Heavy cast screens are mocked down to single buttons so the test can drive
 * the phase machine (login -> starter -> dialogue completion) deterministically.
 * The background hatch, prechat handoff, lifecycle service, and navigation are
 * all mocked so we can assert the orchestration without real I/O.
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

// --- prechat handoff ---------------------------------------------------------
interface CapturedPreChatContext {
  occupation?: string;
  initialMessage?: string;
  assistantName?: string;
  tasks: string[];
}
const setPendingPreChatContextMock = mock(
  (_ctx: CapturedPreChatContext) => {},
);
const setPendingAssistantNameMock = mock((_name: string) => {});

mock.module("@/domains/onboarding/prechat", () => ({
  setPendingPreChatContext: setPendingPreChatContextMock,
  setPendingAssistantName: setPendingAssistantNameMock,
}));

// --- lifecycle / navigation --------------------------------------------------
const markExpectingFirstMessageMock = mock(() => {});
const checkAssistantMock = mock(async (_assistantId?: string) => {});
const setActiveAssistantIdMock = mock((_id: string) => {});
const setSelectedAssistantMock = mock(async (_id: string) => {});
const navigateMock = mock(() => {});

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    markExpectingFirstMessage: markExpectingFirstMessageMock,
    checkAssistant: checkAssistantMock,
  },
}));

mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ setActiveAssistantId: setActiveAssistantIdMock }),
  },
}));

const setSearchParamsMock = mock(() => {});
// Mutable so individual tests can flip the flow into preview mode.
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () =>
    [searchParamsValue, setSearchParamsMock] as const,
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
    onIdentity?: (id: { lastName: string; role: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="login-continue"
      onClick={() => {
        onContinue("Alice");
        onIdentity?.({ lastName: "Example", role: "Software Engineer" });
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
  startMock.mockClear();
  awaitReadyMock.mockClear();
  setPendingPreChatContextMock.mockClear();
  setPendingAssistantNameMock.mockClear();
  markExpectingFirstMessageMock.mockClear();
  checkAssistantMock.mockClear();
  setActiveAssistantIdMock.mockClear();
  setSelectedAssistantMock.mockClear();
  navigateMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CastOnboardingFlow handoff", () => {
  test("entering the login phase starts the hatch exactly once", async () => {
    render(<CastOnboardingFlow />);
    await screen.findByTestId("login-continue");
    expect(startMock).toHaveBeenCalledTimes(1);

    // Re-rendering / advancing past login must not re-fire the hatch.
    fireEvent.click(screen.getByTestId("login-continue"));
    await screen.findByTestId("preamble-continue");
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  test("completion builds a context with occupation + research directive and stashes it", async () => {
    render(<CastOnboardingFlow />);
    await completeFlow();

    await waitFor(() => expect(setPendingPreChatContextMock).toHaveBeenCalledTimes(1));

    const ctx = setPendingPreChatContextMock.mock.calls[0]![0];
    expect(ctx.occupation).toBe("Software Engineer");
    expect(ctx.initialMessage).toBe(CAST_RESEARCH_DIRECTIVE);
    expect(ctx.tasks.length).toBeGreaterThan(0);
    // The chosen cast name rides the context, not just the optimistic key.
    expect(ctx.assistantName).toBe("Pixel");

    expect(setPendingAssistantNameMock).toHaveBeenCalledWith("Pixel");
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        expect.stringContaining("onboarding=1"),
        { replace: true },
      ),
    );
  });

  test("completion awaits hatch readiness before navigating", async () => {
    let resolveReady!: (id: string) => void;
    awaitReadyImpl = () =>
      new Promise<string>((resolve) => {
        resolveReady = resolve;
      });

    render(<CastOnboardingFlow />);
    await completeFlow();

    // Readiness still pending: nothing handed off / navigated yet.
    await drainMicrotasks();
    expect(setPendingPreChatContextMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    resolveReady("asst-ready");

    await waitFor(() => expect(setPendingPreChatContextMock).toHaveBeenCalledTimes(1));
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
    expect(setPendingPreChatContextMock).not.toHaveBeenCalled();

    // Retrying re-arms the hatch and, once it succeeds, completes the handoff.
    awaitReadyImpl = async () => "asst-retry";
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(setPendingPreChatContextMock).toHaveBeenCalledTimes(1));
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

  test("preview runs no handoff on completion (no hatch wait, no stash, no nav)", async () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<CastOnboardingFlow />);
    await completeFlow();
    await drainMicrotasks();

    expect(startMock).not.toHaveBeenCalled();
    expect(awaitReadyMock).not.toHaveBeenCalled();
    expect(setPendingPreChatContextMock).not.toHaveBeenCalled();
    expect(setPendingAssistantNameMock).not.toHaveBeenCalled();
    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
