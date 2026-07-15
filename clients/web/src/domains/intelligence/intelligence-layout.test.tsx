/**
 * Tests for `IntelligenceLayout`'s two chrome modes.
 *
 * Section pages (`/assistant/skills`, `/assistant/plugins`, …) render the
 * page-shell chrome: a back link to the overview labelled with the
 * assistant's name, and the section's own <h1>. The overview
 * (`/assistant/identity`) and the personality page render bare — they own
 * their full-bleed stage chrome — so no back link or heading appears.
 *
 * On mobile the title moves into the shared top-bar center slot (via
 * `setTopBarCenter`): the section label on section pages, "About <name>"
 * on the bare pages.
 *
 * `useIsMobile` and the slots-store setter are mocked; the assistant name
 * is driven through the real identity store. `MemoryRouter` satisfies the
 * component's `useLocation`/`Link` usage.
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

const { IntelligenceLayout } = await import(
  "@/domains/intelligence/intelligence-layout"
);

const renderLayoutAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
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

describe("IntelligenceLayout — section pages", () => {
  test("renders the section heading and a back chevron to the overview", () => {
    const { container } = renderLayoutAt("/assistant/skills");

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Skills");

    const back = container.querySelector("a");
    expect(back?.getAttribute("href")).toBe("/assistant/identity");
    expect(back?.getAttribute("aria-label")).toBe("Back to Ada");
  });

  test("treats section sub-paths as inside the section", () => {
    const { container } = renderLayoutAt("/assistant/plugins/some-plugin");
    expect(container.querySelector("h1")?.textContent).toBe("Plugins");
  });

  test("on mobile, registers the section label as the top-bar title", () => {
    isMobileRef.value = true;
    renderLayoutAt("/assistant/workspace");

    const lastCall = setTopBarCenterMock.mock.calls.at(-1);
    const node = lastCall?.[0];
    expect(isValidElement(node)).toBe(true);
    expect(renderToStaticMarkup(node as React.ReactElement)).toContain(
      "Workspace",
    );
  });

  test("on desktop, clears the top-bar center", () => {
    renderLayoutAt("/assistant/contacts");
    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });
});

describe("IntelligenceLayout — bare pages (overview, personality)", () => {
  test("the overview renders without back link or heading", () => {
    const { container } = renderLayoutAt("/assistant/identity");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  test("the personality page renders without back link or heading", () => {
    const { container } = renderLayoutAt("/assistant/personality");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  test("on mobile, registers the About title for the overview", () => {
    isMobileRef.value = true;
    renderLayoutAt("/assistant/identity");

    const lastCall = setTopBarCenterMock.mock.calls.at(-1);
    const node = lastCall?.[0];
    expect(isValidElement(node)).toBe(true);
    expect(renderToStaticMarkup(node as React.ReactElement)).toContain(
      "About Ada",
    );
  });
});
