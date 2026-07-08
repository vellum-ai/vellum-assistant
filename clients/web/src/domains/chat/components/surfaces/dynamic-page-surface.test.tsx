import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Surface } from "@/domains/chat/types/types";

mock.module("@/utils/app-html-cache", () => ({
  getCachedAppHtml: () => Promise.resolve("<html></html>"),
  clearAppHtmlCache: () => {},
}));

mock.module("@/stores/pinned-apps-store", () => {
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
  // Match the <button> that contains the "Open App" label, tolerating any
  // child markup between the open tag and the text (icon spans and the
  // translate-safe label span the design-library Button wraps text in), then
  // check the button tag's own attributes for the disabled flag.
  const openAppMatch = html.match(
    /<button([^>]*)>(?:(?!<\/button>)[\s\S])*?Open App/,
  );
  if (!openAppMatch) {
    return false;
  }
  return !openAppMatch[1].includes('disabled=""');
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
        toolCalls={[
          { id: "tc-app", name: "app_create", input: {} },
        ]}
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
        toolCalls={[
          { id: "tc-app", name: "app_create", input: {} },
        ]}
      />,
    );

    expect(rendered).toContain("Open App");
    expect(isOpenAppEnabled(rendered)).toBe(false);
  });
});
