/**
 * Tests for the "let's chat tomorrow" step's calendar-scope re-prompt.
 *
 * Single-file `bun test` only — `mock.module` leaks across files in this repo,
 * so run this file on its own (or via scripts/run-tests.ts).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture the onConnect callback the step hands to the hook so a test can fire
// it with an arbitrary scope set, and spy on the connect trigger.
let capturedOnConnect: ((scopes: string[]) => void) | null = null;
const handleConnectMock = mock(() => {});

mock.module("@/domains/onboarding/hooks/use-google-calendar-connect", () => ({
  useGoogleCalendarConnect: ({
    onConnect,
  }: {
    onConnect: (scopes: string[]) => void;
  }) => {
    capturedOnConnect = onConnect;
    return { handleConnect: handleConnectMock, oauthInProgress: false };
  },
}));

mock.module("@/domains/onboarding/onboarding-tone", () => ({
  useOnboardingTone: () => ({
    bg: "#000000",
    isLight: false,
    fg: "#FFFFFF",
    fgDeep: "#000000",
    fgMuted: "rgba(255,255,255,0.65)",
    wash: "rgba(255,255,255,0.12)",
  }),
}));

const { LetsChatTomorrowStep } = await import(
  "@/domains/onboarding/screens/lets-chat-tomorrow-step"
);

const RE_PROMPT = /Access not enabled/;

function renderStep(props: Partial<Parameters<typeof LetsChatTomorrowStep>[0]>) {
  return render(
    <LetsChatTomorrowStep
      assistantId="asst-1"
      assistantReady={true}
      onConnected={() => {}}
      onSkip={() => {}}
      onBack={() => {}}
      {...props}
    />,
  );
}

describe("LetsChatTomorrowStep", () => {
  beforeEach(() => {
    capturedOnConnect = null;
    handleConnectMock.mockClear();
  });
  afterEach(cleanup);

  test("forwards the granted scopes to onConnected", () => {
    const onConnected = mock((_scopes: string[]) => {});
    renderStep({ onConnected });

    capturedOnConnect?.(["openid", "calendar.events"]);

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected.mock.calls[0]?.[0]).toEqual([
      "openid",
      "calendar.events",
    ]);
  });

  test("hides the re-prompt and shows the connect CTA by default", () => {
    renderStep({ missingCalendarScope: false });

    expect(screen.queryByText(RE_PROMPT)).toBeNull();
    expect(screen.getByText("Connect Calendar →")).toBeDefined();
  });

  test("shows the re-prompt and 'Try again' when the scope is missing", () => {
    renderStep({ missingCalendarScope: true });

    expect(screen.getByText(RE_PROMPT)).toBeDefined();
    expect(screen.getByText("Try again")).toBeDefined();
  });

  test("clears the re-prompt then reopens consent on retry click", () => {
    const onRetry = mock(() => {});
    renderStep({ missingCalendarScope: true, onRetry });

    fireEvent.click(screen.getByText("Try again"));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(handleConnectMock).toHaveBeenCalledTimes(1);
  });

  test("explains why calendar setup is disabled while the assistant starts", () => {
    renderStep({ assistantReady: false });

    expect(screen.getByText("Waking up")).toBeDefined();
    expect(
      screen.getByText("Your assistant is getting ready"),
    ).toBeDefined();
    const button = screen.getByRole("button", {
      name: /Starting assistant/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);

    expect(handleConnectMock).not.toHaveBeenCalled();

    // No skip affordance while the assistant is still waking up.
    expect(screen.queryByText("Skip for now")).toBeNull();
  });
});
