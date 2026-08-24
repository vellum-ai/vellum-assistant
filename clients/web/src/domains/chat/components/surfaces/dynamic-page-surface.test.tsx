import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Surface } from "@/domains/chat/types/types";
import type * as UsePinnedApps from "@/hooks/use-pinned-apps";

mock.module("@/utils/app-html-cache", () => ({
  getCachedAppHtml: () => Promise.resolve("<html></html>"),
  clearAppHtmlCache: () => {},
}));

// Pins come from the app list over React Query; stub the hook so this renders
// without a QueryClient. These cases are about the surface, not about pinning.
mock.module(
  "@/hooks/use-pinned-apps",
  (): Partial<typeof UsePinnedApps> => ({
    usePinnedApps: () => ({
      pinnedApps: [],
      pinnedAppIds: new Set<string>(),
      source: "daemon" as const,
      togglePin: () => {},
      unpin: () => {},
      setColor: () => {},
    }),
  }),
);

import { DynamicPageSurface } from "@/domains/chat/components/surfaces/dynamic-page-surface";

function surface(data: Record<string, unknown>): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "dynamic_page",
    title: "Surface title",
    data,
  };
}

function isOpenAppEnabled(html: string): boolean {
  const openAppMatch = html.match(
    /<button[^>]*>(?:<[^>]*>)*Open App<\/button>/,
  );
  if (!openAppMatch) {
    return false;
  }
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

  test("keeps app cards disabled while the originating tool call is still running", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={{
          ...surface({
            app_id: "app-123",
            html: "<html><body>Scaffold</body></html>",
            preview: { title: "Hello, World", icon: "🚀" },
          }),
          toolCallId: "tc-app",
        }}
        onAction={() => undefined}
        onOpenApp={() => undefined}
        toolCalls={[{ id: "tc-app", name: "app_create", input: {} }]}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });

  test("keeps app cards disabled while the latest surface tool runs without an explicit link", () => {
    const rendered = renderToStaticMarkup(
      <DynamicPageSurface
        surface={surface({
          app_id: "app-123",
          html: "<html><body>Scaffold</body></html>",
          preview: { title: "Hello, World", icon: "🚀" },
        })}
        onAction={() => undefined}
        onOpenApp={() => undefined}
        toolCalls={[{ id: "tc-app", name: "app_create", input: {} }]}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });
});
