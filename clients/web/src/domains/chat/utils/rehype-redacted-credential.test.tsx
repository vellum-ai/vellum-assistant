import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

import { MarkdownMessage } from "@vellumai/design-library";

import {
  REDACTED_CREDENTIAL_TAG,
  rehypeRedactedCredential,
} from "@/domains/chat/utils/rehype-redacted-credential";

import type { Pluggable } from "unified";

const PLUGINS: Pluggable[] = [rehypeRedactedCredential];

/** Stub chip so the test exercises the plugin + extraComponents seam
 *  without the real chip's SDK/store dependencies. */
function StubChip({
  type,
  service,
  field,
}: {
  type?: string;
  service?: string;
  field?: string;
}) {
  return (
    <span
      data-testid="chip"
      data-type={type}
      data-service={service}
      data-field={field}
    />
  );
}

const EXTRA = { [REDACTED_CREDENTIAL_TAG]: StubChip };

const PLAIN = "\u3014redacted:OpenAI Project Key\u3015";
const ENRICHED = "\u3014redacted:Anthropic API Key:anthropic:api_key\u3015";

describe("rehypeRedactedCredential", () => {
  test("upgrades a plain sentinel to a chip element without service/field", () => {
    const { container } = render(
      <MarkdownMessage
        content={`before ${PLAIN} after`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chip = container.querySelector("[data-testid=chip]");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-type")).toBe("OpenAI Project Key");
    expect(chip!.getAttribute("data-service")).toBeNull();
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
    expect(container.textContent).not.toContain("\u3014");
  });

  test("upgrades an enriched sentinel with service and field", () => {
    const { container } = render(
      <MarkdownMessage
        content={`key is ${ENRICHED}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chip = container.querySelector("[data-testid=chip]");
    expect(chip!.getAttribute("data-type")).toBe("Anthropic API Key");
    expect(chip!.getAttribute("data-service")).toBe("anthropic");
    expect(chip!.getAttribute("data-field")).toBe("api_key");
  });

  test("handles multiple sentinels in one text node", () => {
    const { container } = render(
      <MarkdownMessage
        content={`${PLAIN} and ${ENRICHED}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    expect(container.querySelectorAll("[data-testid=chip]")).toHaveLength(2);
    expect(container.textContent).toContain("and");
  });

  test("leaves sentinels inside code blocks as literal text", () => {
    const { container } = render(
      <MarkdownMessage
        content={"```\n" + PLAIN + "\n```"}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    expect(container.querySelector("[data-testid=chip]")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain(PLAIN);
  });

  test("neutralized (forged) sentinels render as literal text, not chips", () => {
    // A word joiner after the open bracket is the daemon's forgery
    // neutralization — the plugin must not match it.
    const neutralized =
      "\u3014\u2060redacted:GitHub Token:github-app:pem\u3015";
    const { container } = render(
      <MarkdownMessage
        content={`quoted: ${neutralized}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    expect(container.querySelector("[data-testid=chip]")).toBeNull();
    expect(container.textContent).toContain("redacted:GitHub Token");
  });

  test("leaves sentinels inside link text as literal text (no nested buttons)", () => {
    // A chip's reveal/copy controls are buttons; emitting them inside an <a>
    // is invalid HTML and would double-fire the link navigation. The sentinel
    // must stay literal text within the anchor instead.
    const { container } = render(
      <MarkdownMessage
        content={`see [my ${ENRICHED} key](https://example.com)`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    // No chip is emitted and no button is nested inside the anchor — the
    // sentinel survives as literal text (brackets and all) instead.
    expect(container.querySelector("[data-testid=chip]")).toBeNull();
    expect(anchor!.querySelector("button")).toBeNull();
    expect(anchor!.textContent).toContain(ENRICHED);
  });

  test("plain text without sentinels is untouched", () => {
    const { container } = render(
      <MarkdownMessage
        content="nothing redacted here"
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    expect(container.querySelector("[data-testid=chip]")).toBeNull();
    expect(container.textContent).toContain("nothing redacted here");
  });
});
