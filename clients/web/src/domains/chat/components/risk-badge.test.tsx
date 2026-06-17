/**
 * Tests for `RiskBadge`.
 *
 * Uses `renderToStaticMarkup` since the workspace lacks jsdom.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RiskBadge } from "@/domains/chat/components/risk-badge";

describe("RiskBadge", () => {
  test("renders the Low label for low risk", () => {
    const html = renderToStaticMarkup(<RiskBadge level="low" />);
    expect(html).toContain("Low");
    expect(html).toContain('data-testid="risk-badge"');
    expect(html).toContain('data-risk-level="low"');
  });

  test("renders the Medium label for medium risk", () => {
    const html = renderToStaticMarkup(<RiskBadge level="medium" />);
    expect(html).toContain("Medium");
  });

  test("renders the High label for high risk", () => {
    const html = renderToStaticMarkup(<RiskBadge level="high" />);
    expect(html).toContain("High");
  });

  test("renders the Workspace label for workspace risk", () => {
    const html = renderToStaticMarkup(<RiskBadge level="workspace" />);
    expect(html).toContain("Workspace");
  });

  test("renders null for undefined level", () => {
    const html = renderToStaticMarkup(<RiskBadge />);
    expect(html).toBe("");
  });

  test("renders null for empty-string level", () => {
    const html = renderToStaticMarkup(<RiskBadge level="" />);
    expect(html).toBe("");
  });
});
