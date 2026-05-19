/**
 * Tests for SelfHostedScreen.
 *
 * Rendered to a static HTML string with `renderToStaticMarkup` since the web
 * workspace doesn't pull in @testing-library/react. Mirrors the pattern in
 * GracePeriodBanner.test.tsx and the inspector prompt-tab tests.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pushMock = mock((..._args: unknown[]) => {});

mock.module("@/domains/chat/hooks/use-routing", () => ({
  useRouting: () => ({ push: pushMock, replace: mock(), replaceUrl: mock(), searchParams: new URLSearchParams() }),
}));

import { SelfHostedScreen } from "@/domains/chat/components/self-hosted-screen.js";

describe("SelfHostedScreen", () => {
  test("renders a self-hosted explanation and a settings entry point", () => {
    const html = renderToStaticMarkup(createElement(SelfHostedScreen));
    expect(html).toContain("Self-hosted assistant");
    expect(html).toContain("Manage your assistant from settings");
    expect(html).toContain("Open settings");
  });
});
