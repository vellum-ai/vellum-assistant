/**
 * The personality stage's back control. On a phone `IntelligenceLayout`
 * publishes the back pill into the chat header, so the stage must not paint a
 * second one; on a roomy window no bar is published and the stage carries it.
 *
 * The data hooks are mocked down to the stage itself, which is all these
 * assertions read.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    accentHex: null,
  }),
}));

mock.module("@/domains/intelligence/use-assistant-identity-details", () => ({
  useAssistantIdentityDetails: () => ({
    data: { identity: { name: "Ada" } },
  }),
  assistantIdentityDetailsQueryKey: () => ["identity-details"],
}));

mock.module("@/assistant/personality-sliders", () => ({
  personalitySlidersQueryKey: () => ["personality-sliders"],
  fetchPersonalitySliders: async () => ({}),
  savePersonalitySliders: async () => {},
  completeSliderValues: (values: Record<string, number>) => values,
}));

const { PersonalityPage } =
  await import("@/domains/intelligence/personality-page");

const renderPage = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/assistant/personality"]}>
        <PersonalityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  isMobileRef.value = false;
});

afterEach(cleanup);

test("on a roomy window the stage carries its own back control", () => {
  renderPage();
  expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
});

test("on mobile the stage draws no back control of its own", () => {
  isMobileRef.value = true;
  renderPage();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  // The headline still names the page, so nothing else went missing with it.
  expect(screen.getByText("Shape my personality")).toBeDefined();
});
