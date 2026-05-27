/**
 * Tests for SelfHostedScreen.
 *
 * Uses `renderToStaticMarkup` with a `StaticRouter` wrapper so
 * `useNavigate()` has a routing context.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";

import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen";

function render() {
  return renderToStaticMarkup(
    createElement(StaticRouter, { location: "/" }, createElement(SelfHostedScreen)),
  );
}

describe("SelfHostedScreen", () => {
  test("renders a self-hosted explanation and a settings entry point", () => {
    const html = render();
    expect(html).toContain("Self-hosted assistant");
    expect(html).toContain("Manage your assistant from settings");
    expect(html).toContain("Open settings");
  });
});
