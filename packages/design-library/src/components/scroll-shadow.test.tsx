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
    // Inline as well as by class: the inline property is what holds in an
    // app that never generates the class.
    expect(html).toMatch(/style="[^"]*scrollbar-width:none/);
    expect(html).toContain("[&amp;::-webkit-scrollbar]:hidden");
  });

  test("leaves the scrollbar alone by default", () => {
    const html = renderToStaticMarkup(<ScrollShadow>x</ScrollShadow>);
    expect(html).not.toContain("scrollbar-width:none");
  });

  test("applies a mask when enabled and omits it when disabled", () => {
    const enabled = renderToStaticMarkup(<ScrollShadow>x</ScrollShadow>);
    expect(enabled).toContain("mask-image");

    const disabled = renderToStaticMarkup(
      <ScrollShadow isEnabled={false}>x</ScrollShadow>,
    );
    expect(disabled).not.toContain("mask-image");
  });

  test("fadeEdges drops the stops for the edge it opts out of", () => {
    const both = renderToStaticMarkup(<ScrollShadow size={16}>x</ScrollShadow>);
    expect(both).toContain("#000 16px");
    expect(both).toContain("calc(100% - 16px)");

    const startOnly = renderToStaticMarkup(
      <ScrollShadow size={16} fadeEdges="start">
        x
      </ScrollShadow>,
    );
    expect(startOnly).toContain("#000 16px");
    expect(startOnly).not.toContain("calc(100% - 16px)");

    const endOnly = renderToStaticMarkup(
      <ScrollShadow size={16} fadeEdges="end">
        x
      </ScrollShadow>,
    );
    expect(endOnly).not.toContain("#000 16px");
    expect(endOnly).toContain("calc(100% - 16px)");
  });
});
