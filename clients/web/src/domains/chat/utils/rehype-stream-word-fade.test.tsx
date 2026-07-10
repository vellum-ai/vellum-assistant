import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

import { MarkdownMessage } from "@vellumai/design-library";

import { rehypeStreamWordFade } from "@/domains/chat/utils/rehype-stream-word-fade";

import type { Pluggable } from "unified";

const REVEALING: Pluggable[] = [[rehypeStreamWordFade, { caughtUp: false }]];
const CAUGHT_UP: Pluggable[] = [[rehypeStreamWordFade, { caughtUp: true }]];

describe("rehypeStreamWordFade", () => {
  test("wraps each word in a fade span without altering the text", () => {
    const { container } = render(
      <MarkdownMessage
        content={"Hello **bold** world"}
        extraRehypePlugins={REVEALING}
      />,
    );
    const spans = container.querySelectorAll("span.stream-word-fade");
    expect([...spans].map((s) => s.textContent)).toEqual([
      "Hello",
      "bold",
      "world",
    ]);
    // Bold structure survives: the wrapped word sits inside <strong>.
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.textContent).toContain("Hello bold world");
  });

  test("revealing mode grades the trailing words toward transparent", () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    const { container } = render(
      <MarkdownMessage content={words} extraRehypePlugins={REVEALING} />,
    );
    const spans = [...container.querySelectorAll("span.stream-word-fade")];
    expect(spans).toHaveLength(12);
    const opacities = spans.map((s) =>
      (s as HTMLElement).style.opacity === ""
        ? 1
        : Number((s as HTMLElement).style.opacity),
    );
    // Early words are untouched (full opacity), the tail ramps down toward
    // the reveal edge, and the last word is the most transparent — but the
    // grading is deliberately slight: it bottoms out above the fade floor
    // (0.55), never near-invisible.
    expect(opacities[0]).toBe(1);
    const edge = opacities[opacities.length - 1];
    expect(edge).toBeLessThan(0.7);
    expect(edge).toBeGreaterThanOrEqual(0.55);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThanOrEqual(opacities[i - 1]);
    }
  });

  test("caughtUp mode keeps the spans but applies no grading", () => {
    const { container } = render(
      <MarkdownMessage
        content={"one two three four"}
        extraRehypePlugins={CAUGHT_UP}
      />,
    );
    const spans = [...container.querySelectorAll("span.stream-word-fade")];
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      expect((span as HTMLElement).style.opacity).toBe("");
    }
  });

  test("preserves inter-word whitespace as bare text nodes", () => {
    const { container } = render(
      <MarkdownMessage content={"one two"} extraRehypePlugins={REVEALING} />,
    );
    const p = container.querySelector("p");
    expect(p?.textContent).toBe("one two");
    expect(p?.querySelectorAll("span.stream-word-fade")).toHaveLength(2);
  });

  test("leaves code blocks and inline code untouched", () => {
    const { container } = render(
      <MarkdownMessage
        content={"pre `inline code` and\n\n```\nconst a = 1;\n```"}
        extraRehypePlugins={REVEALING}
      />,
    );
    const codeEls = container.querySelectorAll("code");
    expect(codeEls.length).toBeGreaterThanOrEqual(2);
    for (const code of codeEls) {
      expect(code.querySelector("span.stream-word-fade")).toBeNull();
    }
    expect(container.textContent).toContain("const a = 1;");
  });

  test("no spans when the plugin is not passed", () => {
    const { container } = render(<MarkdownMessage content={"Hello world"} />);
    expect(container.querySelector("span.stream-word-fade")).toBeNull();
  });
});
