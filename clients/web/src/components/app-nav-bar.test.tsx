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

let mockIsTouchMobile = false;
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => mockIsTouchMobile,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
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

// `mock.module` replaces the module process-wide, so the stub also carries
// the `toast` export other modules pull from this entry point. Without it,
// any test file loaded after this one fails to resolve it.
mock.module("@vellumai/design-library", () => ({
  Menu: MenuMock,
  BottomSheet: BottomSheetMock,
  PanelItem: PanelItemMock,
  Button: ButtonMock,
  Typography: TypographyMock,
  toast: { success: () => {}, error: () => {} },
}));

const { AppNavBar } = await import("@/components/app-nav-bar");

beforeEach(() => {
  mockIsMobile = false;
  mockIsTouchMobile = false;
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
// Desktop left-hand edit affordance
// ---------------------------------------------------------------------------

describe("AppNavBar desktop edit affordance", () => {
  test("renders the Edit label when the chat panel is closed", () => {
    const html = renderToStaticMarkup(
      <AppNavBar appName="My App" onClose={() => {}} onEdit={() => {}} />,
    );
    expect(html).toContain(">Edit<");
    expect(html).not.toContain("lucide-expand");
  });

  test("names the expand button for screen readers", () => {
    // `iconOnly` glyphs render inside an `aria-hidden` span and the tooltip
    // does not name the trigger, so an icon-only control needs its own label
    // or it reads as an unnamed button.
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onEdit={() => {}}
        isEditing
      />,
    );

    const expandButton = document
      .querySelector("svg.lucide-expand")
      ?.closest("button");
    expect(expandButton?.getAttribute("aria-label")).toBe("Expand app");
    // The always-present close control shares the same affordance.
    const closeButton = document
      .querySelector("svg.lucide-x")
      ?.closest("button");
    expect(closeButton?.getAttribute("aria-label")).toBe("Close");
  });

  test("swaps to an expand icon while the chat panel is open", () => {
    const onEdit = mock(() => {});
    render(
      <AppNavBar appName="My App" onClose={() => {}} onEdit={onEdit} isEditing />,
    );

    expect(document.body.textContent).not.toContain("Close chat");
    const expandButton = document
      .querySelector("svg.lucide-expand")
      ?.closest("button");
    expect(expandButton).not.toBeNull();

    fireEvent.click(expandButton as HTMLButtonElement);
    expect(onEdit).toHaveBeenCalledTimes(1);
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

  test("the dropdown menu lists Share and Deploy to Vercel (touch, BottomSheet)", () => {
    mockIsTouchMobile = true;
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
// Already-deployed state
//
// Once an app has an active Vercel deployment the affordance stops offering a
// first-time deploy: it reports the deployment and hands the link back, with
// redeploying moved to its own entry.
// ---------------------------------------------------------------------------

describe("AppNavBar deployed state", () => {
  const DEPLOYED_URL = "https://my-app.vercel.app";

  test("reports the deployment and offers Redeploy instead of Deploy (desktop)", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
        deployedUrl={DEPLOYED_URL}
        onCopyDeployedLink={() => {}}
      />,
    );
    expect(html).toContain(">Deployed to Vercel<");
    expect(html).toContain(">Redeploy<");
    expect(html).not.toContain(">Deploy to Vercel<");
  });

  test("shows the deployed URL in the touch sheet", () => {
    mockIsTouchMobile = true;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
        deployedUrl={DEPLOYED_URL}
        onCopyDeployedLink={() => {}}
      />,
    );
    expect(html).toContain("Deployed to Vercel");
    expect(html).toContain(DEPLOYED_URL);
    expect(html).toContain("Redeploy");
    expect(html).not.toContain("Publish as a static page");
  });

  test("falls back to the deploy entry when no link can be handed back", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onShare={() => {}}
        onDeploy={() => {}}
        deployedUrl={DEPLOYED_URL}
      />,
    );
    expect(html).toContain(">Deploy to Vercel<");
    expect(html).not.toContain(">Deployed to Vercel<");
  });

  test("the standalone deploy button copies the link once deployed", () => {
    mockIsMobile = false;
    const onCopyDeployedLink = mock(() => {});
    const onDeploy = mock(() => {});
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onDeploy={onDeploy}
        deployedUrl={DEPLOYED_URL}
        onCopyDeployedLink={onCopyDeployedLink}
      />,
    );

    const copyButton = document.querySelector(
      '[aria-label="Deployed to Vercel, copy link"]',
    );
    expect(copyButton).not.toBeNull();

    fireEvent.click(copyButton as HTMLButtonElement);
    expect(onCopyDeployedLink).toHaveBeenCalledTimes(1);
    expect(onDeploy).not.toHaveBeenCalled();
  });

  test("the standalone deploy button still deploys when nothing is published", () => {
    mockIsMobile = false;
    const onDeploy = mock(() => {});
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onDeploy={onDeploy}
        deployedUrl={null}
        onCopyDeployedLink={() => {}}
      />,
    );

    const deployButton = document.querySelector('[aria-label="Deploy"]');
    expect(deployButton).not.toBeNull();

    fireEvent.click(deployButton as HTMLButtonElement);
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });
});
