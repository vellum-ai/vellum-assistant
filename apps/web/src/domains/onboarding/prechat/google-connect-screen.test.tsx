/**
 * Structural smoke tests for the GoogleConnectScreen component.
 *
 * Uses `renderToStaticMarkup` (same pattern as other pre-chat screen tests).
 * useEffect and event handlers don't run in the server renderer, so these
 * tests verify the rendered markup rather than interaction behaviour.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub modules that require a browser/network environment.
mock.module("@/lib/native-auth.js", () => ({
  useIsNativePlatform: () => false,
}));

mock.module("@/lib/native-deep-link.js", () => ({}));

mock.module("@/lib/use-oauth-complete-deep-link-listener.js", () => ({
  useOAuthCompleteDeepLinkListener: () => {},
}));

mock.module("@/lib/browser.js", () => ({
  openUrl: async () => {},
  openUrlFinishedListener: () => () => {},
}));

mock.module("@/lib/routes.js", () => ({
  routes: {
    account: {
      oauth: {
        // Test stub — matches the real popup-complete route defined in routes.ts
         
        popupComplete: "/account/oauth/popup-complete",
      },
    },
  },
}));

mock.module("@/clients/platform/@tanstack/react-query.gen", () => ({
  assistantsOauthStartCreateMutation: () => ({
    mutationFn: async () => ({ connect_url: "https://accounts.google.com/o/oauth2/auth" }),
  }),
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["assistantsOauthConnectionsList"],
    queryFn: async () => [],
  }),
}));

mock.module("@/components/app/settings/integration-detail-modal.js", () => ({
  getOAuthCompleteMessagePayload: () => null,
  getOAuthCompleteStoragePayload: () => null,
  isOAuthCompletePayloadForRequest: () => false,
  oauthCompletionStorageKey: (id: string) => `vellum:oauth-complete:${id}`,
}));

import { GoogleConnectScreen } from "@/domains/onboarding/prechat/google-connect-screen.js";

const NOOP = () => {};

function renderScreen(
  overrides: Partial<Parameters<typeof GoogleConnectScreen>[0]> = {},
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(GoogleConnectScreen, {
        assistantId: "assistant-abc",
        assistantName: "Iris",
        selectedGoogleToolIds: ["gmail", "google-calendar"],
        onConnect: NOOP,
        onSkip: NOOP,
        onBack: NOOP,
        ...overrides,
      }),
    ),
  );
}

describe("GoogleConnectScreen", () => {
  test("renders the hero title", () => {
    const html = renderScreen();
    expect(html).toContain("Connect to Google");
  });

  test("renders the value-prop copy referencing selected tools", () => {
    const html = renderScreen();
    expect(html).toContain("inbox and calendar");
  });

  test("renders the primary Connect Google button", () => {
    const html = renderScreen();
    expect(html).toContain("Connect Google");
  });

  test("renders the Skip for now button", () => {
    const html = renderScreen();
    expect(html).toContain("Skip for now");
  });

  test("renders a back button with aria-label Back", () => {
    const html = renderScreen();
    expect(html).toContain('aria-label="Back"');
  });
});
