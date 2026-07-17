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
  neutralized,
}: {
  type?: string;
  service?: string;
  field?: string;
  neutralized?: boolean;
}) {
  return (
    <span
      data-testid="chip"
      data-type={type}
      data-service={service}
      data-field={field}
      data-neutralized={neutralized ? "true" : undefined}
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

  test("decodes percent-encoded segments to the real vault coordinates", () => {
    // Colon-qualified service names are percent-encoded into the sentinel
    // (see buildRedactedSentinel); the chip must receive the DECODED values
    // so its reveal request hits the actual credential.
    const encoded =
      "\u3014redacted:OAuth Access Token:integration%3Agoogle:access_token\u3015";
    const { container } = render(
      <MarkdownMessage
        content={`key is ${encoded}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chip = container.querySelector("[data-testid=chip]");
    expect(chip!.getAttribute("data-service")).toBe("integration:google");
    expect(chip!.getAttribute("data-field")).toBe("access_token");
  });

  test("malformed percent-escape degrades to a non-revealable chip", () => {
    const forged = "\u3014redacted:Generic Secret:bad%zzsvc:api_key\u3015";
    const { container } = render(
      <MarkdownMessage
        content={forged}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chip = container.querySelector("[data-testid=chip]");
    expect(chip!.getAttribute("data-type")).toBe("Generic Secret");
    expect(chip!.getAttribute("data-service")).toBeNull();
    expect(chip!.getAttribute("data-field")).toBeNull();
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

  test("neutralized (forged) sentinels become a generic inert badge carrying none of the span's claims", () => {
    // A word joiner after the open bracket is the daemon's forgery
    // neutralization. The span renders as a badge element flagged
    // `neutralized` — never a revealable chip, and none of its own
    // type/service/field claims are forwarded: displaying them would lend a
    // forgery the daemon's voice.
    const neutralized =
      "\u3014\u2060redacted:GitHub Token:github-app:pem\u3015";
    const { container } = render(
      <MarkdownMessage
        content={`quoted: ${neutralized}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chip = container.querySelector("[data-testid=chip]");
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute("data-neutralized")).toBe("true");
    expect(chip!.getAttribute("data-type")).toBeNull();
    expect(chip!.getAttribute("data-service")).toBeNull();
    expect(chip!.getAttribute("data-field")).toBeNull();
    expect(container.textContent).not.toContain("redacted:GitHub Token");
  });

  test("a genuine and a neutralized sentinel in one text node split correctly", () => {
    const neutralized = "\u3014\u2060redacted:Credential:test:qa_token\u3015";
    const { container } = render(
      <MarkdownMessage
        content={`real ${ENRICHED} vs defused ${neutralized}`}
        extraRehypePlugins={PLUGINS}
        extraComponents={EXTRA}
      />,
    );
    const chips = container.querySelectorAll("[data-testid=chip]");
    expect(chips.length).toBe(2);
    expect(chips[0].getAttribute("data-service")).toBe("anthropic");
    expect(chips[0].getAttribute("data-neutralized")).toBeNull();
    expect(chips[1].getAttribute("data-neutralized")).toBe("true");
    expect(chips[1].getAttribute("data-service")).toBeNull();
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
