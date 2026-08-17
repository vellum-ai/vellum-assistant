/**
 * Rendering checks for the contacts catalog entries that are not plain
 * strings.
 *
 * `catalogs.test.ts` already proves every message parses as ICU and that no
 * placeholder is dropped in translation. Neither of those catches the two ways
 * these particular entries break:
 *
 * - A `Trans` tag whose name does not match a key in the call site's
 *   `components` map renders as literal text instead of an element, so the
 *   sentence still reads correctly in a snapshot of its text content while the
 *   markup is wrong. These assert the text and the element separately.
 * - A `plural` branch can be well-formed and still select the wrong category,
 *   or lose the count. Each form is asserted at the boundary that selects it.
 *
 * The expected strings are the English copy verbatim, so a copy edit that
 * forgets a catalog is a failure here rather than a bug report.
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Trans, useTranslation } from "@/i18n";

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, "");
}

test("the link dialog names the contact inside the sentence", () => {
  const markup = renderToStaticMarkup(
    <Trans
      i18nKey="linkAccountDialog.description"
      ns="contacts"
      values={{ channel: "Slack", name: "Ada" }}
      components={{ contact: <span className="highlight" /> }}
    />,
  );

  expect(textOf(markup)).toBe(
    "Search your Slack workspace and pick Ada’s account.",
  );
  expect(markup).toContain('<span class="highlight">Ada</span>');
});

test("the link dialog emphasizes the guardian-linked term", () => {
  const markup = renderToStaticMarkup(
    <Trans
      i18nKey="linkAccountDialog.guardianLinkNote"
      ns="contacts"
      components={{ emphasis: <span className="highlight" /> }}
    />,
  );

  expect(textOf(markup)).toBe(
    "Picking marks this account as guardian-linked: you vouch for the identity, no handshake needed.",
  );
  expect(markup).toContain('<span class="highlight">guardian-linked</span>');
});

test("the merge summary quotes the donor inside the sentence", () => {
  const markup = renderToStaticMarkup(
    <Trans
      i18nKey="contactMergeDialog.donorDeleted"
      ns="contacts"
      values={{ donor: "Bob" }}
      components={{ donor: <span className="highlight" /> }}
    />,
  );

  expect(textOf(markup)).toBe("“Bob” will be deleted.");
  expect(markup).toContain('<span class="highlight">“Bob”</span>');
});

function Message({
  render,
}: {
  render: (t: ReturnType<typeof useTranslation<"contacts">>["t"]) => string;
}) {
  const { t } = useTranslation("contacts");
  return <>{render(t)}</>;
}

function messageText(
  render: (t: ReturnType<typeof useTranslation<"contacts">>["t"]) => string,
): string {
  return textOf(renderToStaticMarkup(<Message render={render} />));
}

test("moved channels read correctly at none, one, and many", () => {
  expect(
    messageText((t) =>
      t("contactMergeDialog.channelsMoved", {
        count: 0,
        survivor: "you",
        channels: "",
      }),
    ),
  ).toBe("No new channels will move to you.");

  expect(
    messageText((t) =>
      t("contactMergeDialog.channelsMoved", {
        count: 1,
        survivor: "Ada",
        channels: "Slack",
      }),
    ),
  ).toBe("1 channel will move to Ada: Slack.");

  expect(
    messageText((t) =>
      t("contactMergeDialog.channelsMoved", {
        count: 2,
        survivor: "Ada",
        channels: "Slack, Email",
      }),
    ),
  ).toBe("2 channels will move to Ada: Slack, Email.");
});

test("skipped duplicates read correctly at one and many", () => {
  expect(
    messageText((t) =>
      t("contactMergeDialog.duplicatesSkipped", { count: 1, survivor: "Ada" }),
    ),
  ).toBe("1 duplicate channel already on Ada (skipped).");

  expect(
    messageText((t) =>
      t("contactMergeDialog.duplicatesSkipped", { count: 3, survivor: "Ada" }),
    ),
  ).toBe("3 duplicate channels already on Ada (skipped).");
});

test("the interaction count agrees with its number", () => {
  expect(messageText((t) => t("contact.interactions", { count: 1 }))).toBe(
    "1 interaction",
  );
  expect(messageText((t) => t("contact.interactions", { count: 5 }))).toBe(
    "5 interactions",
  );
});
