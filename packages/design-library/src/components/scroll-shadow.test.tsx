import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ScrollShadow } from "./scroll-shadow";

describe("ScrollShadow", () => {
  test("renders a vertical scroll container wrapping its children", () => {
    const html = renderToStaticMarkup(
      <ScrollShadow>
        <p>quoted content</p>
      </ScrollShadow>,
    );
    expect(html).toContain('data-slot="scroll-shadow"');
    expect(html).toContain('data-orientation="vertical"');
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("quoted content");
  });

  test("horizontal orientation scrolls on the x axis", () => {
    const html = renderToStaticMarkup(
      <ScrollShadow orientation="horizontal">x</ScrollShadow>,
    );
    expect(html).toContain('data-orientation="horizontal"');
    expect(html).toContain("overflow-x-auto");
  });

  test("hideScrollBar hides the scrollbar", () => {
    const html = renderToStaticMarkup(
      <ScrollShadow hideScrollBar>x</ScrollShadow>,
    );
    expect(html).toContain("scrollbar-width:none");
  });

  test("applies a mask when enabled and omits it when disabled", () => {
    const enabled = renderToStaticMarkup(<ScrollShadow>x</ScrollShadow>);
    expect(enabled).toContain("mask-image");

    const disabled = renderToStaticMarkup(
      <ScrollShadow isEnabled={false}>x</ScrollShadow>,
    );
    expect(disabled).not.toContain("mask-image");
  });
});
