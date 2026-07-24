/**
 * Tests for LibraryEmptyState.
 *
 * Renders to static markup via `react-dom/server` and asserts on the emitted
 * HTML. The focus is the file-picker `accept` filter: on desktop the picker is
 * constrained to `.vellum`, while touch devices (where iOS ignores extension
 * filters) get an unrestricted picker so the bundle is actually selectable.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryEmptyState } from "./library-empty-state";

function render(opts: {
  accept: string | undefined;
  onNewConversation?: () => void;
}) {
  return renderToStaticMarkup(
    createElement(LibraryEmptyState, {
      accept: opts.accept,
      fileInputRef: { current: null },
      isImporting: false,
      onImportBundle: () => {},
      onNewConversation: opts.onNewConversation,
    }),
  );
}

describe("LibraryEmptyState", () => {
  test("constrains the picker to .vellum when an accept filter is given", () => {
    const html = render({ accept: ".vellum" });
    expect(html).toContain('accept=".vellum"');
  });

  test("leaves the picker unrestricted when accept is undefined (touch)", () => {
    const html = render({ accept: undefined });
    expect(html).not.toContain("accept=");
  });

  test("always renders the import and new-conversation entry points", () => {
    const html = render({ accept: ".vellum", onNewConversation: () => {} });
    expect(html).toContain("Import .vellum File");
    expect(html).toContain("New Conversation");
  });
});
