import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

import { MarkdownMessage } from "@vellumai/design-library";

import { rehypeStreamWordFade } from "@/domains/chat/utils/rehype-stream-word-fade";

const PLUGINS = [rehypeStreamWordFade];

describe("rehypeStreamWordFade", () => {
  test("wraps each word in a fade span without altering the text", () => {
    const { container } = render(
      <MarkdownMessage
        content={"Hello **bold** world"}
        extraRehypePlugins={PLUGINS}
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

  test("preserves inter-word whitespace as bare text nodes", () => {
    const { container } = render(
      <MarkdownMessage content={"one two"} extraRehypePlugins={PLUGINS} />,
    );
    const p = container.querySelector("p");
    expect(p?.textContent).toBe("one two");
    expect(p?.querySelectorAll("span.stream-word-fade")).toHaveLength(2);
  });

  test("leaves code blocks and inline code untouched", () => {
    const { container } = render(
      <MarkdownMessage
        content={"pre `inline code` and\n\n```\nconst a = 1;\n```"}
        extraRehypePlugins={PLUGINS}
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
