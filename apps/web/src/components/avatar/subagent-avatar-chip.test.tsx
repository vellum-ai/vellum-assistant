import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { subagentTraits } from "@/utils/avatar-subagent";

describe("SubagentAvatarChip", () => {
  test("is deterministic: same subagentId renders identical DOM", () => {
    const a = renderToStaticMarkup(<SubagentAvatarChip subagentId="alpha" />);
    const b = renderToStaticMarkup(<SubagentAvatarChip subagentId="alpha" />);
    expect(a).toBe(b);
  });

  test("different subagentIds produce different traits", () => {
    const t1 = subagentTraits("alpha");
    const t2 = subagentTraits("beta-quite-different");
    expect(
      t1.bodyShape !== t2.bodyShape ||
        t1.eyeStyle !== t2.eyeStyle ||
        t1.color !== t2.color,
    ).toBe(true);
  });

  test("different subagentIds produce different DOM", () => {
    const a = renderToStaticMarkup(<SubagentAvatarChip subagentId="alpha" />);
    const b = renderToStaticMarkup(
      <SubagentAvatarChip subagentId="beta-quite-different" />,
    );
    expect(a).not.toBe(b);
  });

  test("sets aria-label and applies className passthrough", () => {
    const html = renderToStaticMarkup(
      <SubagentAvatarChip subagentId="alpha" className="ml-1" />,
    );
    expect(html).toContain('aria-label="Subagent alpha"');
    // The wrapper composes `inline-flex` (so the avatar still flows inline)
    // with any caller-supplied className.
    expect(html).toContain("ml-1");
    expect(html).toContain("inline-flex");
  });

  test("renders the wrapper as a div (not a span) — see HTML validity fix", () => {
    // The wrapper used to be a `<span>`, but `AvatarRenderer` renders a
    // `<div>` inside. `<div>` inside `<span>` is invalid HTML and browsers
    // auto-close the span, dropping the className and aria-label. Use a
    // `<div>` wrapper so the chrome stays valid.
    const html = renderToStaticMarkup(<SubagentAvatarChip subagentId="alpha" />);
    expect(html.startsWith("<div")).toBe(true);
  });

  test("defaults to 16px size when none provided", () => {
    const html = renderToStaticMarkup(<SubagentAvatarChip subagentId="alpha" />);
    expect(html).toContain("width:16px");
    expect(html).toContain("height:16px");
  });

  test("honors a custom size", () => {
    const html = renderToStaticMarkup(
      <SubagentAvatarChip subagentId="alpha" size={24} />,
    );
    expect(html).toContain("width:24px");
    expect(html).toContain("height:24px");
  });
});
