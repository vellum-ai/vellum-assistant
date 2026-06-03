/**
 * Tests for `IntelligenceLayout`'s mobile/desktop title placement.
 *
 * On mobile the "About <name>" title moves into the shared top-bar center
 * slot (via `setTopBarCenter`) and the in-body <h1> is hidden with
 * `max-md:hidden`. On desktop the in-body <h1> renders the title and the
 * top-bar center is cleared (`setTopBarCenter(null)`).
 *
 * `useIsMobile` and the slots-store setter are mocked; the assistant name is
 * driven through the real identity store. `MemoryRouter` satisfies the
 * component's `useLocation`/`NavLink` usage.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isValidElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const isMobileRef = { value: false };
const setTopBarCenterMock = mock((_node: unknown) => {});

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: {
      setTopBarCenter: () => setTopBarCenterMock,
    },
  },
}));

// The real feature-flag store imports the generated API client, which isn't
// available under the test runner. Stub the two selectors the layout reads;
// `false` for `externalPlugins` keeps the baseline tab set.
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      hasHydrated: () => true,
      externalPlugins: () => false,
    },
  },
}));

const { IntelligenceLayout } = await import(
  "@/domains/intelligence/intelligence-layout"
);

const renderLayout = () =>
  render(
    <MemoryRouter>
      <IntelligenceLayout />
    </MemoryRouter>,
  );

beforeEach(() => {
  isMobileRef.value = false;
  setTopBarCenterMock.mockClear();
  useAssistantIdentityStore.getState().setIdentity("Ada", null);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("IntelligenceLayout", () => {
  test("on mobile, registers the centered title and hides the in-body h1", () => {
    isMobileRef.value = true;
    const { container } = renderLayout();

    // The in-body h1 still renders the title but is hidden on mobile.
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("About Ada");
    expect(heading?.className).toContain("max-md:hidden");

    // The top-bar center receives a node that renders the dynamic title.
    const lastCall = setTopBarCenterMock.mock.calls.at(-1);
    const node = lastCall?.[0];
    expect(isValidElement(node)).toBe(true);
    expect(renderToStaticMarkup(node as React.ReactElement)).toContain(
      "About Ada",
    );
  });

  test("on desktop, renders the in-body title and clears the top-bar center", () => {
    isMobileRef.value = false;
    const { container } = renderLayout();

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("About Ada");

    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });
});
