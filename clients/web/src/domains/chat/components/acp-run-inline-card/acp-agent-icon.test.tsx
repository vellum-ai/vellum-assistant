import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";

describe("AcpAgentIcon", () => {
  test("renders the Claude brand mark for a claude agent", () => {
    const html = renderToStaticMarkup(<AcpAgentIcon agent="claude" />);
    expect(html).toContain("claude.svg");
    expect(html).toContain("acp-agent-icon-brand");
  });

  test("maps codex / gpt variants to the OpenAI mark", () => {
    expect(renderToStaticMarkup(<AcpAgentIcon agent="gpt-5-codex" />)).toContain(
      "chatgpt.svg",
    );
  });

  test("matches model variants by substring (claude-sonnet)", () => {
    expect(
      renderToStaticMarkup(<AcpAgentIcon agent="claude-sonnet-4" />),
    ).toContain("claude.svg");
  });

  test("falls back to a neutral Code glyph for an unknown agent", () => {
    const html = renderToStaticMarkup(<AcpAgentIcon agent="mystery-agent" />);
    expect(html).not.toContain("prior-assistants");
    expect(html).not.toContain("acp-agent-icon-brand");
    // lucide renders an <svg>; the fallback is not a brand <img>.
    expect(html).toContain("<svg");
  });

  test("falls back when the agent is undefined", () => {
    const html = renderToStaticMarkup(<AcpAgentIcon agent={undefined} />);
    expect(html).not.toContain("acp-agent-icon-brand");
    expect(html).toContain("<svg");
  });
});
