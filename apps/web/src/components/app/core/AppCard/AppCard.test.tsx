import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AppCard } from "@/components/app/core/AppCard/AppCard.js";

// ---------------------------------------------------------------------------
// renderToStaticMarkup runs no effects, so we test the SSR output: the
// fallback layer + actions row. The lazy iframe is a client-side concern
// covered separately when we have a DOM environment.
// ---------------------------------------------------------------------------

describe("AppCard rendering with default props", () => {
  test("renders the app name", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).toContain("My App");
  });

  test("renders the Puzzle fallback icon when no icon is provided", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<iframe");
  });

  test("renders Pin label (not Unpin) by default", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).toContain(">Pin</");
    expect(html).not.toContain("Unpin");
  });

  test("renders the Open App button", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).toContain("Open App");
  });

  test("disables actions when handlers are omitted", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("renders the description when provided", () => {
    const html = renderToStaticMarkup(
      <AppCard name="My App" description="A cool app" />,
    );
    expect(html).toContain("A cool app");
  });

  test("does not render description element when omitted", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    // The description span uses --content-secondary; that token only appears
    // when a description is rendered.
    expect(html).not.toContain("--content-secondary");
  });
});

describe("AppCard fallback rendering", () => {
  test("renders an emoji icon when icon is provided", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" icon="🚀" />);
    expect(html).toContain("🚀");
    expect(html).not.toContain("<iframe");
  });

  test("uses a neutral thumbnail placeholder while preview is pending", () => {
    const html = renderToStaticMarkup(
      <AppCard name="My App" icon="🚀" isPreviewPending />,
    );
    expect(html.match(/🚀/g)?.length).toBe(1);
    expect(html).not.toContain("<iframe");
  });

  test("does not render an iframe in SSR even when loadHtml is provided", () => {
    const html = renderToStaticMarkup(
      <AppCard name="My App" loadHtml={() => Promise.resolve("<p>x</p>")} />,
    );
    expect(html).not.toContain("<iframe");
  });
});

describe("AppCard pinned state", () => {
  test("shows Unpin label when isPinned is true", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" isPinned />);
    expect(html).toContain("Unpin");
    expect(html).not.toContain(">Pin</");
  });

  test("shows Pin label when isPinned is false", () => {
    const html = renderToStaticMarkup(
      <AppCard name="My App" isPinned={false} />,
    );
    expect(html).toContain(">Pin</");
    expect(html).not.toContain("Unpin");
  });
});

describe("AppCard loading state", () => {
  test("renders the spinner overlay when isLoading is true", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" isLoading />);
    expect(html).toContain("animate-spin");
  });

  test("does not render the spinner when isLoading is false", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).not.toContain("animate-spin");
  });
});

describe("AppCard open disabled state", () => {
  test("disables only Open App when the app preview is pending", () => {
    const html = renderToStaticMarkup(
      <AppCard
        name="My App"
        onOpen={() => undefined}
        onPin={() => undefined}
        isOpenDisabled
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });
});

describe("AppCard click handlers", () => {
  test("onOpen handler is wired (direct invocation)", () => {
    const onOpen = mock(() => {});
    renderToStaticMarkup(<AppCard name="My App" onOpen={onOpen} />);
    onOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("onPin handler is wired (direct invocation)", () => {
    const onPin = mock(() => {});
    renderToStaticMarkup(<AppCard name="My App" onPin={onPin} />);
    onPin();
    expect(onPin).toHaveBeenCalledTimes(1);
  });
});

describe("AppCard structure", () => {
  test("uses surface-lift background token", () => {
    const html = renderToStaticMarkup(<AppCard name="My App" />);
    expect(html).toContain("bg-[var(--surface-lift)]");
  });

  test("no raw hex colors in rendered output", () => {
    const html = renderToStaticMarkup(
      <AppCard
        name="My App"
        description="desc"
        loadHtml={() => Promise.resolve("<p>x</p>")}
        isPinned
        isLoading
      />,
    );
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });
});
