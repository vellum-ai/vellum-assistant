/**
 * Tests for `IntelligenceLayout`'s mobile/desktop title placement.
 *
 * On mobile the "About <name>" title moves into the shared top-bar center
 * slot (via `setTopBarCenter`) and the in-body <h1> is hidden with
 * `max-md:hidden`. On desktop the in-body <h1> renders the title and the
 * top-bar center is cleared (`setTopBarCenter(null)`).
 *
 * A second suite covers the Plugins tab's backwards-compat version gate:
 * the tab only appears once the connected assistant's version is known and
 * at or above the plugin-routes minimum.
 *
 * `useIsMobile` and the slots-store setter are mocked; the assistant name
 * and version are driven through the real identity store. `MemoryRouter`
 * satisfies the component's `useLocation`/`NavLink` usage.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isValidElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { MIN_VERSION } from "@/lib/backwards-compat/plugins-surface";
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

describe("IntelligenceLayout — Plugins tab version gate", () => {
  const tabLabels = (container: HTMLElement): (string | null)[] =>
    Array.from(container.querySelectorAll("nav a")).map((a) => a.textContent);

  test("shows the Plugins tab (between Identity and Skills) on a plugin-capable assistant", () => {
    useAssistantIdentityStore.getState().setIdentity("Ada", MIN_VERSION);
    const { container } = renderLayout();
    expect(tabLabels(container)).toEqual([
      "Identity",
      "Plugins",
      "Skills",
      "Workspace",
      "Contacts",
    ]);
  });

  test("hides the Plugins tab on an assistant too old for the plugin routes", () => {
    useAssistantIdentityStore.getState().setIdentity("Ada", "0.10.2");
    const { container } = renderLayout();
    expect(tabLabels(container)).not.toContain("Plugins");
  });

  test("hides the Plugins tab until the assistant version hydrates", () => {
    // beforeEach already seeds a null version; assert the pre-hydration
    // default keeps the tab hidden rather than flashing it in.
    const { container } = renderLayout();
    expect(tabLabels(container)).not.toContain("Plugins");
  });
});
