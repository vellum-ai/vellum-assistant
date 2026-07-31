import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ensureWidgetFontCss,
  getWidgetFontCss,
  resetWidgetFontCssForTests,
} from "@/utils/widget-fonts";

const realFetch = globalThis.fetch;

function applyStyle(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function fontFace(family: string, url: string): string {
  return `@font-face{font-family:"${family}";src:url("${url}") format("truetype");}`;
}

/** Serves every request as three bytes, or fails the ones listed in `failing`. */
function stubFetch(failing: string[] = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (failing.includes(url)) {
      return new Response(null, { status: 404 });
    }
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
}

beforeEach(() => {
  resetWidgetFontCssForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const style of Array.from(document.head.querySelectorAll("style"))) {
    style.remove();
  }
});

describe("ensureWidgetFontCss", () => {
  test("inlines the brand @font-face rules as data URIs", async () => {
    // GIVEN the host loading a brand font by URL
    applyStyle(fontFace("DM Sans", "/assets/DMSans-abc123.ttf"));
    stubFetch();

    // WHEN the snapshot resolves
    const css = await ensureWidgetFontCss();

    // THEN the rule survives with its src rewritten, so an opaque-origin
    // iframe can load the font without a cross-origin request
    expect(css).toContain("<style>");
    expect(css).toContain('font-family: "DM Sans"');
    expect(css).toContain("data:font/ttf;base64,AQID");
    expect(css).not.toContain("/assets/DMSans-abc123.ttf");
    expect(getWidgetFontCss()).toBe(css);
  });

  test("ignores font families outside the brand set", async () => {
    applyStyle(fontFace("Comic Sans MS", "/assets/comic.ttf"));
    stubFetch();

    expect(await ensureWidgetFontCss()).toBe("");
  });

  test("skips a font whose file cannot be fetched, keeping the rest", async () => {
    applyStyle(
      fontFace("DM Sans", "/assets/DMSans.ttf") +
        fontFace("DM Mono", "/assets/DMMono.ttf"),
    );
    stubFetch(["/assets/DMMono.ttf"]);

    const css = await ensureWidgetFontCss();

    expect(css).toContain('font-family: "DM Sans"');
    expect(css).not.toContain('font-family: "DM Mono"');
  });

  test("degrades to an empty snapshot when nothing is discoverable", async () => {
    stubFetch();
    // No @font-face rules at all — widgets fall back to the system-ui tail of
    // --font-sans rather than failing to render.
    expect(await ensureWidgetFontCss()).toBe("");
  });

  test("does the work once and reuses the cached snapshot", async () => {
    applyStyle(fontFace("DM Sans", "/assets/DMSans.ttf"));
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

    await Promise.all([ensureWidgetFontCss(), ensureWidgetFontCss()]);
    await ensureWidgetFontCss();

    expect(calls).toBe(1);
  });
});
