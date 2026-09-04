/**
 * Provider signup gates Continue on a first name and stashes that name for
 * research onboarding. Role stays optional.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const getProviderSignup = mock(() =>
  Promise.resolve({
    ok: true as const,
    data: {
      user: {
        email: "user@example.com",
        username: "user1",
        first_name: "",
        last_name: "",
      },
    },
  }),
);

const submitProviderSignup = mock(() =>
  Promise.resolve({ ok: true as const, data: {} }),
);

mock.module("@/lib/auth/allauth-client", () => ({
  getProviderSignup,
  submitProviderSignup,
  isConflict: () => false,
}));

mock.module("@/assistant/platform-assistants-sync", () => ({
  refreshPlatformAssistantsIfStale: async () => {},
}));

const refreshSession = mock(async () => true);

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      refreshSession: () => refreshSession,
    },
  },
}));

mock.module("@/domains/account/login-flow", () => ({
  resolvePostAuthDestination: () => ({
    destination: "/assistant",
    requiresFullPageNavigation: false,
  }),
  resolvePostLoginDestination: () => ({
    destination: "/assistant",
    requiresFullPageNavigation: false,
  }),
}));

mock.module("@/domains/account/components/signup-shell", () => ({
  SignupShell: ({ children }: { children: ReactNode }) => children,
}));

const { ProviderSignupPage } = await import(
  "@/domains/account/pages/provider-signup-page"
);
const { peekSignupOnboardingFirstName, takeSignupOnboardingFirstName } =
  await import("@/lib/auth/signup-onboarding-handoff");

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /continue/i });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/account/provider-signup"]}>
      <Routes>
        <Route
          path="/account/provider-signup"
          element={<ProviderSignupPage />}
        />
        <Route path="/assistant" element={<div>assistant</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getProviderSignup.mockClear();
  submitProviderSignup.mockClear();
  refreshSession.mockClear();
  takeSignupOnboardingFirstName();
});

afterEach(() => {
  takeSignupOnboardingFirstName();
  cleanup();
});

describe("ProviderSignupPage first name", () => {
  test("Continue is disabled until a first name is entered", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("First name")).toBeTruthy();
    });

    const firstName = screen.getByPlaceholderText(
      "First name",
    ) as HTMLInputElement;
    expect(firstName.disabled).toBe(false);
    expect(firstName.readOnly).toBe(false);
    expect(continueButton().disabled).toBe(true);

    fireEvent.change(firstName, { target: { value: "Alice" } });
    expect(continueButton().disabled).toBe(false);
  });

  test("submits the typed first name into the onboarding handoff", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("First name")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(continueButton());

    await waitFor(() => {
      expect(submitProviderSignup).toHaveBeenCalledTimes(1);
    });
    expect(peekSignupOnboardingFirstName()).toBe("Alice");
  });
});
