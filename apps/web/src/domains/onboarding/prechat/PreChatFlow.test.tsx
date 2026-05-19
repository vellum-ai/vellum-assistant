/**
 * Tests for PreChatFlow orchestrator.
 *
 * The repo lacks a DOM test runner, so we render to static markup with
 * `react-dom/server`. That path skips `useEffect` (so the gate effect
 * doesn't fire) and skips event handling (so screen transitions can't
 * be exercised end-to-end). What we CAN assert from a static render:
 *
 *   1. The initial mount renders the tool selection screen.
 *   2. The default page export is a function component.
 *
 * The screen-transition + finish() path is covered indirectly by the
 * three child screens' own tests + the prechat module's storage tests.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
}));

// Stub the generated assistantsActiveRetrieveOptions so useQuery in
// PreChatFlow doesn't hit the network. We return a stable query options
// object that immediately resolves to null (the assistant may not exist
// in static-render tests).
mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  assistantsActiveRetrieveOptions: () => ({
    queryKey: ["assistantsActiveRetrieve"],
    queryFn: () => Promise.resolve(null),
  }),
}));

// Auth always logged in for the static-render tests; the gate effect
// doesn't run via renderToStaticMarkup so this is just to satisfy the
// hook contract during render. `firstName` / `lastName` default to
// empty strings — the per-screen seeding behavior is covered by
// NameExchangeScreen.test.tsx and usePrefilledInput.test.ts.
const mockAuth: {
  isLoggedIn: boolean;
  isLoading: boolean;
  userId: string | null;
  username: string | null;
  email: string | null;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
  logout: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
} = {
  isLoggedIn: true,
  isLoading: false,
  userId: "test-user",
  username: "test-user",
  email: "user@example.com",
  firstName: "",
  lastName: "",
  isAdmin: false,
  logout: () => Promise.resolve(),
  refreshSession: () => Promise.resolve(true),
};
mock.module("@/lib/auth.js", () => ({
  useAuth: () => mockAuth,
}));

// The orchestrator reads `readOnboardingCompleted` from prefs to decide
// whether to bounce to /assistant, and uses the `useOnboardingCompleted`
// hook to flip the flag in finish(). Stub both for the static-render
// smoke tests so the gate proceeds and the flow renders normally.
mock.module("@/lib/onboarding/prefs.js", () => ({
  readOnboardingCompleted: () => false,
  // TOS gate (added to defend against direct navigation past
  // /onboarding/privacy). Default to true so the flow renders normally
  // for the existing smoke tests.
  readTosAccepted: () => true,
  useOnboardingCompleted: () => [false, () => {}] as const,
}));

// Avoid pulling in the real Sentry module during static render — it
// touches the network / window on import.
mock.module("@sentry/react", () => ({
  captureException: () => {},
}));

// Capture `setPendingPreChatContext` calls — verifies finish() wires
// up the storage handoff with the expected payload.
const persistedContexts: unknown[] = [];
mock.module("@/lib/onboarding/prechat.js", () => ({
  setPendingPreChatContext: (ctx: unknown) => {
    persistedContexts.push(ctx);
  },
  setPendingAssistantName: () => {},
}));

mock.module("@/lib/onboarding/prechat-names.js", () => ({
  DEFAULT_GROUP_ID: "grounded",
  PERSONALITY_GROUPS: [
    {
      id: "grounded",
      label: "Grounded",
      descriptor: "Calm and precise",
      tagline: "Measured. No filler.",
      names: ["Penn", "Sage"],
    },
    {
      id: "warm",
      label: "Warm",
      descriptor: "Warm and easy",
      tagline: "Friendly and casual.",
      names: ["Kit", "Remy"],
    },
    {
      id: "energetic",
      label: "Energetic",
      descriptor: "Fast and direct",
      tagline: "Brief. To the point.",
      names: ["Nova", "Ember"],
    },
    {
      id: "poetic",
      label: "Poetic",
      descriptor: "Quiet and observant",
      tagline: "Listens, then replies.",
      names: ["Luna", "Iris"],
    },
  ],
  sampleSuggestionNames: () => ["Penn", "Sage", "Wren", "Milo", "Nova", "Kit"],
}));

// Stub the in-memory consent signals — the gate uses
// hasRecentPrivacyConsent as a fallback for storage-disabled browsers.
// Default to false so the test relies solely on the readTosAccepted
// stub above (which returns true by default).
mock.module("@/lib/onboarding/signals.js", () => ({
  hasRecentPrivacyConsent: () => false,
}));

import { PreChatFlow } from "@/domains/onboarding/prechat/PreChatFlow.js";
import PreChatPage from "@/domains/onboarding/prechat/page.js";

afterEach(() => {
  persistedContexts.length = 0;
});

function renderWithQueryClient(ui: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

describe("PreChatFlow — static render", () => {
  test("renders the NameExchangeScreen on initial mount (new screen order)", () => {
    const html = renderWithQueryClient(<PreChatFlow />);
    // Name exchange screen's hero h1 is uniquely identifying.
    expect(html).toContain("Let");
    expect(html).toContain("get to know each other");
  });

});

describe("PreChatPage module", () => {
  test("default export is a function component", () => {
    expect(typeof PreChatPage).toBe("function");
  });
});
