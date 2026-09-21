/**
 * Tests for the ListRow design library primitive. Renders to static markup
 * and asserts on the emitted HTML.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ListRow } from "./list-row";

describe("ListRow", () => {
  test("renders data-slot on the root", () => {
    expect(renderToStaticMarkup(<ListRow title="Row" />)).toContain(
      'data-slot="list-row"',
    );
  });

  test("with neither onClick nor href the content is a plain div with no chevron", () => {
    const html = renderToStaticMarkup(<ListRow title="Row" />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<svg");
  });

  test("onClick makes the content a button and adds the chevron", () => {
    const html = renderToStaticMarkup(
      <ListRow title="Row" onClick={() => {}} />,
    );
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("<svg");
  });

  test("href makes the content an anchor", () => {
    const html = renderToStaticMarkup(<ListRow title="Row" href="/next" />);
    expect(html).toMatch(/<a[^>]*href="\/next"/);
    expect(html).not.toContain("<button");
  });

  test("href + onClick stays an anchor, so the handler can route client-side", () => {
    // The anchor keeps its href for new-tab and copy-link; React attaches the
    // handler, which static markup cannot show, so assert the element choice.
    const html = renderToStaticMarkup(
      <ListRow title="Row" href="/next" onClick={() => {}} />,
    );
    expect(html).toMatch(/<a[^>]*href="\/next"/);
    expect(html).not.toContain("<button");
  });

  test("a disabled href row is not a link", () => {
    const html = renderToStaticMarkup(
      <ListRow title="Row" href="/next" disabled />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("opacity-60");
  });

  test("the interactive area uses the library keyboard focus ring", () => {
    const html = renderToStaticMarkup(
      <ListRow title="Row" onClick={() => {}} />,
    );
    expect(html).toContain("keyboard-focus:ring-[var(--ring)]");
    expect(html).not.toContain("focus-visible:");
  });

  test("leading and interactive trailing sit outside the interactive area", () => {
    const html = renderToStaticMarkup(
      <ListRow
        title="Row"
        onClick={() => {}}
        leading={<input type="checkbox" data-testid="lead" />}
        trailing={<button type="button">menu</button>}
        trailingInteractive
      />,
    );
    const row = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    expect(row).not.toContain('data-testid="lead"');
    expect(row).not.toContain("menu");
    expect(html).toContain("menu");
  });

  test("selected paints the active surface and drops the hover wash", () => {
    const html = renderToStaticMarkup(
      <ListRow title="Row" onClick={() => {}} selected />,
    );
    expect(html).toContain("bg-[var(--surface-active)]");
    expect(html).not.toContain("hover:bg-[var(--surface-hover)]");
  });
});
