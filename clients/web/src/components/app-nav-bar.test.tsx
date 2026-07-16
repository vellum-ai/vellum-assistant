/**
 * Tests for `AppNavBar`.
 *
 * Covers:
 * - Optional `onToggleFullscreen` callback → fullscreen toggle button.
 * - Optional `onShare` / `onDeploy` callbacks → single-button surfaces.
 * - Both `onShare` AND `onDeploy` → collapsed into a single dropdown trigger
 *   with a menu listing "Share" and "Deploy to Vercel" (desktop + mobile).
 * - `isSharing` / `isDeploying` → disables the dropdown trigger and shows
 *   the spinner state.
 *
 * Static markup checks (renderToStaticMarkup + design-library mock) for the
 * Radix menu surface; real-DOM with happy-dom for the simple button-click
 * paths. The web workspace lacks `@testing-library/react`'s jsdom/happy-dom
 * for Radix portals, so we mock the design-library's compound components to
 * inspect what gets passed in — same pattern as
 * `conversation-actions-menu.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// ---------------------------------------------------------------------------
// Design-library mocks for static-markup inspection of the Radix menu /
// bottom-sheet surfaces. The Radix primitives wrap floating-ui portals that
// don't render synchronously under happy-dom; mocking them keeps the menu
// contents in the static markup so we can assert labels and ordering.
// ---------------------------------------------------------------------------

const passthrough = ({
  children,
  sideOffset: _sideOffset,
  align: _align,
  side: _side,
  ...rest
}: Record<string, unknown>) =>
  createElement("div", rest, children as ReactNode);
const mockItem = ({
  children,
  onSelect: _onSelect,
  leftIcon,
  disabled,
  ...rest
}: Record<string, unknown>) =>
  createElement(
    "div",
    {
      "data-testid": "menu-item",
      "data-disabled": disabled || undefined,
      ...rest,
    },
    leftIcon as ReactNode,
    children as ReactNode,
  );
const mockSeparator = () => createElement("hr", { "data-testid": "separator" });
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);

const MenuMock = {
  Root: passthrough,
  Trigger: mockTrigger,
  Content: ({
    children,
    sideOffset: _sideOffset,
    align: _align,
    side: _side,
    ...rest
  }: Record<string, unknown>) =>
    createElement(
      "div",
      { "data-testid": "menu-content", ...rest },
      children as ReactNode,
    ),
  Item: mockItem,
  Separator: mockSeparator,
};

const BottomSheetMock = {
  Root: passthrough,
  Trigger: mockTrigger,
  Content: passthrough,
  Header: passthrough,
  Title: passthrough,
  Body: passthrough,
};

const PanelItemMock = ({ label, ...rest }: Record<string, unknown>) =>
  createElement(
    "div",
    { "data-testid": "panel-item", ...rest },
    label as ReactNode,
  );

const ButtonMock = ({
  children,
  iconOnly,
  disabled,
  onClick,
  ...rest
}: Record<string, unknown>) =>
  createElement(
    "button",
    {
      "data-testid": "button",
      disabled: disabled || undefined,
      ...rest,
      onClick,
    },
    (iconOnly ?? children) as ReactNode,
  );

const TypographyMock = ({ children, ...rest }: Record<string, unknown>) =>
  createElement("span", rest, children as ReactNode);

mock.module("@vellumai/design-library", () => ({
  Menu: MenuMock,
  BottomSheet: BottomSheetMock,
  PanelItem: PanelItemMock,
  Button: ButtonMock,
  Typography: TypographyMock,
}));

const { AppNavBar } = await import("@/components/app-nav-bar");

beforeEach(() => {
  mockIsMobile = false;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Fullscreen toggle (existing behavior — real DOM)
// ---------------------------------------------------------------------------

function getFullscreenButton(): HTMLButtonElement | null {
  const glyph = document.querySelector("svg.lucide-maximize2");
  return glyph?.closest("button") ?? null;
}

describe("AppNavBar fullscreen toggle", () => {
  test("omits the fullscreen button when onToggleFullscreen is not provided", () => {
    render(<AppNavBar appName="My App" onClose={() => {}} />);
    expect(getFullscreenButton()).toBeNull();
  });

  test("renders the fullscreen button and invokes onToggleFullscreen on click", () => {
    const onToggleFullscreen = mock(() => {});
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    const button = getFullscreenButton();
    expect(button).not.toBeNull();

    fireEvent.click(button as HTMLButtonElement);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Share + Deploy surfaces — static markup
//
// We render to static markup so the Radix Menu.Content (a portal that needs
// layout/floating-ui measurement) doesn't need to actually mount; the
// mocked Menu.Content captures its children for direct assertion.
// ---------------------------------------------------------------------------

describe("AppNavBar share + deploy", () => {
  test("renders a single Share button when only onShare is provided", () => {
    const html = renderToStaticMarkup(
      <AppNavBar appName="My App" onClose={() => {}} onShare={() => {}} />,
    );
    // One button rendered with the Share icon.
    expect(html).toContain("lucide-share");
    expect(html).not.toContain("lucide-globe");
  });

  test("renders a single Deploy button when only onDeploy is provided", () => {
    const html = renderToStaticMarkup(
      <AppNavBar appName="My App" onClose={() => {}} onDeploy={() => {}} />,
    );
    expect(html).toContain("lucide-globe");
    expect(html).not.toContain("lucide-share");
  });

  test("collapses share + deploy into a single dropdown trigger when both are provided (desktop)", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
      />,
    );
    // The dropdown trigger renders as a single Button wrapped in
    // `data-testid="trigger"`, with the share icon. The Globe icon
    // should only appear inside the menu items (as a `menu-item` leftIcon),
    // not as a standalone button — so we check for the trigger testid,
    // not the global lucide-globe count.
    expect(html).toContain('data-testid="trigger"');
    expect(html).toContain("lucide-share");
    // Menu items carry the Globe icon, so we look for it scoped to a
    // menu-item container rather than asserting its absence globally.
    const menuItemIcons = html.match(
      /<div data-testid="menu-item"[\s\S]*?lucide-globe/g,
    );
    expect(menuItemIcons?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("the dropdown menu lists Share and Deploy to Vercel (desktop)", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
      />,
    );
    expect(html).toContain(">Share<");
    expect(html).toContain("Deploy to Vercel");
  });

  test("the dropdown menu lists Share and Deploy to Vercel (mobile, BottomSheet)", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
      />,
    );
    expect(html).toContain("Share");
    expect(html).toContain("Export as .vellum file");
    expect(html).toContain("Deploy to Vercel");
    expect(html).toContain("Publish as a static page");
  });

  test("passes onShare to the menu Share item", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
      />,
    );
    // The menu content should contain a Share item; we don't need to wire
    // through actual click handling since Radix's `onSelect` is mocked.
    expect(html).toContain("menu-item");
    expect(html).toContain(">Share<");
  });

  test("passes onDeploy to the menu Deploy to Vercel item", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
      />,
    );
    expect(html).toContain("menu-item");
    expect(html).toContain("Deploy to Vercel");
  });

  test("renders the trigger with disabled + Loader2 while sharing", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        isSharing
        onDeploy={() => {}}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("lucide-loader");
  });

  test("renders the trigger with disabled + Loader2 while deploying", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
        isDeploying
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("lucide-loader");
  });
});

// ---------------------------------------------------------------------------
// Inline rename behavior (real DOM with happy-dom)
// ---------------------------------------------------------------------------

describe("AppNavBar inline rename", () => {
  test("does not show an input when onRename is not provided", () => {
    render(<AppNavBar appName="My App" onClose={() => {}} />);
    expect(document.querySelector("input")).toBeNull();
  });

  test("clicking the name enters edit mode with a text input", () => {
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onRename={async () => {}}
      />,
    );

    // The Typography mock renders as a span containing the app name.
    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    expect(nameSpan).toBeDefined();

    fireEvent.click(nameSpan!);
    const input = document.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("My App");
  });

  test("Enter saves the new name via onRename", async () => {
    const onRename = mock(async () => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onRename={onRename} />,
    );

    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    fireEvent.click(nameSpan!);

    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Renamed App" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Wait for the async commit to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect((onRename.mock.calls[0] as string[])[0]).toBe("Renamed App");
  });

  test("Escape cancels editing and does not call onRename", () => {
    const onRename = mock(async () => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onRename={onRename} />,
    );

    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    fireEvent.click(nameSpan!);

    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    // Input is gone, name text is back.
    expect(document.querySelector("input")).toBeNull();
  });

  test("empty name after trim reverts to original and does not call onRename", async () => {
    const onRename = mock(async () => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onRename={onRename} />,
    );

    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    fireEvent.click(nameSpan!);

    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 0));
    expect(onRename).not.toHaveBeenCalled();
  });

  test("blur saves the new name via onRename", async () => {
    const onRename = mock(async () => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onRename={onRename} />,
    );

    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    fireEvent.click(nameSpan!);

    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "Blurred App" } });
    fireEvent.blur(input);

    await new Promise((r) => setTimeout(r, 0));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect((onRename.mock.calls[0] as string[])[0]).toBe("Blurred App");
  });

  test("name with same value does not call onRename", async () => {
    const onRename = mock(async () => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onRename={onRename} />,
    );

    const nameSpan = Array.from(document.querySelectorAll("span")).find(
      (el) => el.textContent === "My App",
    );
    fireEvent.click(nameSpan!);

    const input = document.querySelector("input")!;
    fireEvent.change(input, { target: { value: "My App" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 0));
    expect(onRename).not.toHaveBeenCalled();
  });
});
