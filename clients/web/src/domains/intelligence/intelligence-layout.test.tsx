/**
 * Tests for `IntelligenceLayout`'s two chrome modes.
 *
 * Section pages (`/assistant/superpowers`, `/assistant/schedules`, …) render
 * the page-shell chrome: a back link to the overview labelled with the
 * assistant's name, and the section's own <h1>. The overview
 * (`/assistant/identity`) and the personality page render bare — they own
 * their full-bleed stage chrome — so no back link or heading appears.
 *
 * On mobile the title moves into the shared top-bar center slot (via
 * `setTopBarCenter`): the section label on section pages; the bare pages
 * set no title (the stage greeting already names the assistant). Library and
 * Contacts instead publish the complete mobile bar through `setMobileTopBar`,
 * and back to that section's list while the page reports a pushed detail
 * screen through `intelligence-layout-slots-store`.
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

import type { MobileTopBarSlot } from "@/components/layout/chat-layout-slots-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const isMobileRef = { value: false };
const setTopBarCenterMock = mock((_node: unknown) => {});
const setMobileTopBarMock = mock((_slot: unknown) => {});

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: {
      setTopBarCenter: () => setTopBarCenterMock,
      setMobileTopBar: () => setMobileTopBarMock,
    },
  },
}));

const { IntelligenceLayout } =
  await import("@/domains/intelligence/intelligence-layout");
const { useIntelligenceLayoutSlotsStore } =
  await import("@/components/layout/intelligence-layout-slots-store");

const renderLayoutAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <IntelligenceLayout />
    </MemoryRouter>,
  );

/** The slot the layout last published, or undefined when it published none. */
const lastMobileTopBar = (): MobileTopBarSlot | undefined => {
  const slot = setMobileTopBarMock.mock.calls.at(-1)?.[0];
  return slot == null ? undefined : (slot as MobileTopBarSlot);
};

/** The props of an element in a slot, for assertions the markup cannot make. */
const slotProps = (node: React.ReactNode): Record<string, unknown> =>
  (node as { props?: Record<string, unknown> } | null)?.props ?? {};

beforeEach(() => {
  isMobileRef.value = false;
  setTopBarCenterMock.mockClear();
  setMobileTopBarMock.mockClear();
  useAssistantIdentityStore.getState().setIdentity("Ada", null);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null);
  useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(false);
});

describe("IntelligenceLayout — section pages", () => {
  test("renders the section heading and a back chevron to the overview", () => {
    const { container } = renderLayoutAt("/assistant/superpowers");

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("My Superpowers");

    const back = container.querySelector("a");
    expect(back?.getAttribute("href")).toBe("/assistant/identity");
    expect(back?.getAttribute("aria-label")).toBe("Back to Ada");
  });

  test("treats section sub-paths as inside the section", () => {
    const { container } = renderLayoutAt("/assistant/plugins/some-plugin");
    expect(container.querySelector("h1")?.textContent).toBe("My Superpowers");
  });

  test("legacy skill detail paths wear the My Superpowers chrome", () => {
    const { container } = renderLayoutAt("/assistant/skills/my-skill");
    expect(container.querySelector("h1")?.textContent).toBe("My Superpowers");
  });

  test("the schedules page renders as a section, including detail sub-paths", () => {
    const { container } = renderLayoutAt("/assistant/schedules/sch_123");
    expect(container.querySelector("h1")?.textContent).toBe("Schedules");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/assistant/identity",
    );
  });

  test("the library page renders as a section with the back chevron", () => {
    const { container } = renderLayoutAt("/assistant/library");
    expect(container.querySelector("h1")?.textContent).toBe("Library");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/assistant/identity",
    );
  });

  test("the memory page renders as a section with the back chevron", () => {
    const { container } = renderLayoutAt("/assistant/memory");
    expect(container.querySelector("h1")?.textContent).toBe("Memory");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/assistant/identity",
    );
  });

  test("renders a registered header action on the heading row", () => {
    useIntelligenceLayoutSlotsStore
      .getState()
      .setHeaderTrailing(<button type="button">Import</button>);
    const { container } = renderLayoutAt("/assistant/library");

    const heading = container.querySelector("h1")!;
    const action = container.querySelector("button")!;
    expect(action.textContent).toBe("Import");
    // Same row as the title: the heading's own flex container holds it.
    expect(heading.parentElement!.contains(action)).toBe(true);
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

  test.each([
    { section: "Library", path: "/assistant/library", action: "Import" },
    { section: "Contacts", path: "/assistant/contacts", action: "Add" },
  ])(
    "on mobile, $section registers one back, title, and action top bar",
    ({ section, path, action }) => {
      isMobileRef.value = true;
      useIntelligenceLayoutSlotsStore
        .getState()
        .setHeaderTrailing(<button type="button">{action}</button>);
      const { container } = renderLayoutAt(path);

      const slot = lastMobileTopBar();
      expect(slot).toBeDefined();
      expect(
        renderToStaticMarkup(slot?.center as React.ReactElement),
      ).toContain(section);
      expect(
        renderToStaticMarkup(slot?.trailing as React.ReactElement),
      ).toContain(action);
      expect(isValidElement(slot?.leading)).toBe(true);
      expect(slotProps(slot?.leading).shape).toBe("pill");
      expect(container.querySelector("h1")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
    },
  );

  test("on mobile, a pushed contact detail backs to the Contacts list", () => {
    isMobileRef.value = true;
    useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(true);
    renderLayoutAt("/assistant/contacts/c_1");

    const leading = slotProps(lastMobileTopBar()?.leading);
    expect(leading["aria-label"]).toBe("Back to Contacts");
    expect(typeof leading.onClick).toBe("function");
    // A plain button, not `asChild` around a <Link>, so nothing navigates
    // before the pop-or-replace decision is made.
    expect(leading.children).toBeUndefined();
    expect(leading.asChild).toBeUndefined();
  });

  /**
   * The flag is published with the navigation into a detail and cleared by
   * the page that owns it, so a list route can be rendered while it is still
   * set: on the way into Contacts, and on the way out to a section that never
   * writes it. A Back aimed at the list on screen is the failure it prevents.
   */
  test.each([
    { list: "the Contacts list", path: "/assistant/contacts" },
    {
      list: "the Contacts list with a trailing slash",
      path: "/assistant/contacts/",
    },
    { list: "the Library list", path: "/assistant/library" },
  ])(
    "on mobile, a set flag leaves $list backing to the overview",
    ({ path }) => {
      isMobileRef.value = true;
      useIntelligenceLayoutSlotsStore.getState().setDetailIsScreen(true);
      renderLayoutAt(path);

      const leading = slotProps(lastMobileTopBar()?.leading);
      expect(leading["aria-label"]).toBe("Back to Ada");
      expect(leading.asChild).toBe(true);
      expect(leading.onClick).toBeUndefined();
      expect(slotProps(leading.children as React.ReactNode).to).toBe(
        "/assistant/identity",
      );
    },
  );

  test("on mobile, a contact detail beside its list backs to the overview", () => {
    // A mobile-width window whose pane still seats the list: the page reports
    // no pushed screen, so a Back to the list would point at a list already
    // on screen.
    isMobileRef.value = true;
    renderLayoutAt("/assistant/contacts/c_1");

    const leading = slotProps(lastMobileTopBar()?.leading);
    expect(leading["aria-label"]).toBe("Back to Ada");
    expect(leading.asChild).toBe(true);
    expect(leading.onClick).toBeUndefined();
    expect(slotProps(leading.children as React.ReactNode).to).toBe(
      "/assistant/identity",
    );
  });

  test("on mobile, Channels still registers only its title", () => {
    isMobileRef.value = true;
    renderLayoutAt("/assistant/channels");

    expect(setMobileTopBarMock).toHaveBeenLastCalledWith(null);
    const node = setTopBarCenterMock.mock.calls.at(-1)?.[0];
    expect(isValidElement(node)).toBe(true);
    expect(renderToStaticMarkup(node as React.ReactElement)).toContain(
      "Channels",
    );
  });

  test("on desktop, clears the top-bar center", () => {
    renderLayoutAt("/assistant/contacts");
    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
    expect(setMobileTopBarMock).toHaveBeenLastCalledWith(null);
  });

  /**
   * The chrome is the only thing that says "Channels". The other half of
   * that split lives in
   * `domains/channels/components/channel-adapter-list.test.tsx`, which
   * pins the page's own rail at zero headings by that name.
   */
  test("the channels page renders as a section with the back chevron", () => {
    const { container } = renderLayoutAt("/assistant/channels");
    expect(container.querySelector("h1")?.textContent).toBe("Channels");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/assistant/identity",
    );
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

  test("on mobile, the overview sets no top-bar title", () => {
    isMobileRef.value = true;
    renderLayoutAt("/assistant/identity");

    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });

  test("on mobile, the personality page sets no top-bar title", () => {
    isMobileRef.value = true;
    renderLayoutAt("/assistant/personality");

    expect(setTopBarCenterMock).toHaveBeenLastCalledWith(null);
  });
});
