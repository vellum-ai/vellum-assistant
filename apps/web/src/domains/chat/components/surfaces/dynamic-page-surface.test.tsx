import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Surface } from "@/domains/chat/lib/types.js";

mock.module("@/domains/chat/api/apps", () => ({
  getCachedAppHtml: () => Promise.resolve("<html></html>"),
}));

mock.module("@/domains/chat/pinned-apps-store", () => {
  const emptyStore = {
    use: {
      pinnedApps: () => [],
      pinnedAppIds: () => new Set<string>(),
      togglePin: () => () => {},
      isPinned: () => () => false,
      onUnpin: () => () => () => {},
    },
    getState: () => ({
      pinnedApps: [],
      pinnedAppIds: new Set<string>(),
      togglePin: () => {},
      isPinned: () => false,
      onUnpin: () => () => {},
    }),
  };
  return { usePinnedAppsStore: emptyStore };
});

import { DynamicPageSurface } from "@/domains/chat/components/surfaces/dynamic-page-surface.js";

function surface(data: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "dynamic_page",
    title: "Surface title",
    data,
  };
}

function isOpenAppEnabled(html: string): boolean {
  const openAppMatch = html.match(/<button[^>]*>(?:<[^>]*>)*Open App<\/button>/);
  if (!openAppMatch) return false;
  return !openAppMatch[0].includes('disabled=""');
}

describe("DynamicPageSurface", () => {
  test("enables preview open when inline HTML exists without a persisted app id", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          html: "<html><body>Hello</body></html>",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(true);
  });

  test("keeps preview open disabled when there is no app id or inline HTML", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          html: "",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });

  test("opens snake_case persisted app ids through the app viewer", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          app_id: " app-123 ",
          html: "<html></html>",
          preview: { title: "Hello, World" },
        })}
        onAction={() => undefined}
        onOpenApp={() => undefined}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(true);
  });

  test("keeps app cards disabled while the app tool is still running", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          app_id: "app-123",
          html: "<html><body>Scaffold</body></html>",
          preview: { title: "Hello, World", icon: "🚀" },
        })}
        onAction={() => undefined}
        onOpenApp={() => undefined}
        isToolCallComplete={false}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });
});
