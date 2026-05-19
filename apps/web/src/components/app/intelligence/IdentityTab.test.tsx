/**
 * Regression tests for `IdentityCard`.
 *
 * The `IdentityCard` component is a presentational extraction from `IdentityTab`
 * that accepts props directly, making it testable with `renderToStaticMarkup`
 * (which does not execute `useEffect` or other client-side hooks).
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// Only mock components with browser-only dependencies (SVG rendering, etc.).
// Do NOT mock Button — it leaks across test files in the same bun process.
// ---------------------------------------------------------------------------

mock.module("@/components/assistant/Avatar/ChatAvatar.js", () => ({
  ChatAvatar: () => <div data-testid="avatar" />,
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { IdentityCard } from "@/components/app/intelligence/IdentityTab.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_PROPS = {
  assistantName: "Becky",
  assistantPersonality: "A deeply thoughtful assistant who loves poetry and long walks on the beach",
  assistantRole: "Personal assistant",
  hatchedDate: "1 Jan 2026",
  components: null,
  traits: null,
  customImageUrl: null,
  onOpenModal: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdentityCard", () => {
  test("heading shows only the name, not the personality", () => {
    const html = renderToStaticMarkup(<IdentityCard {...BASE_PROPS} />);
    // The h2 should contain exactly the name
    expect(html).toContain(">Becky</h2>");
    // Personality must NOT appear in the heading
    expect(html).not.toContain("Becky, A deeply");
    expect(html).not.toContain("Becky,");
  });

  test("personality renders in its own labeled row with hover title", () => {
    const html = renderToStaticMarkup(<IdentityCard {...BASE_PROPS} />);
    expect(html).toContain("Personality");
    expect(html).toContain("A deeply thoughtful assistant");
    expect(html).toContain(
      `title="${BASE_PROPS.assistantPersonality}"`,
    );
  });

  test("personality row shows 'Not set' when empty", () => {
    const html = renderToStaticMarkup(
      <IdentityCard {...BASE_PROPS} assistantPersonality="" />,
    );
    expect(html).toContain("Personality");
    expect(html).toContain("Not set");
  });
});
