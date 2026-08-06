/**
 * Tests for `ContextWindowIndicator`'s opt-in gate.
 *
 * The ring is hidden unless the user turns it on in Settings → General →
 * Preferences: a gauge filling toward "full" reads as an impending failure
 * even though the assistant compacts its own context. These tests pin both
 * halves of that contract — silent by default, visible once opted in.
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

let indicatorEnabled = false;

mock.module("@/utils/composer-settings", () => ({
  showContextWindowIndicator: {
    useValue: () => indicatorEnabled,
    save: () => {},
  },
}));

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
}));

import { ContextWindowIndicator } from "@/domains/chat/components/context-window-indicator";

const USAGE = { tokens: 90_000, maxTokens: 200_000, fillRatio: 0.45 };

beforeEach(() => {
  indicatorEnabled = false;
});

afterEach(() => {
  cleanup();
});

describe("ContextWindowIndicator", () => {
  test("renders nothing while the preference is off", () => {
    // GIVEN usage that would otherwise paint a 45%-full ring
    // WHEN the opt-in preference is off (the shipped default)
    const { container } = render(
      <ContextWindowIndicator usage={USAGE} assistantName="Vellum" />,
    );

    // THEN the composer gets no ring at all
    expect(container.firstChild).toBeNull();
    expect(screen.queryByLabelText(/Context window/)).toBeNull();
  });

  test("renders the ring once the preference is on", () => {
    // GIVEN the user has opted in
    indicatorEnabled = true;

    // WHEN the same usage renders
    render(<ContextWindowIndicator usage={USAGE} assistantName="Vellum" />);

    // THEN the ring appears, labelled with the rounded fill percentage
    expect(screen.getByLabelText("Context window 45% full")).toBeDefined();
  });

  test("stays hidden when opted in but usage is unknown", () => {
    // GIVEN the preference is on but no usage has streamed in yet
    indicatorEnabled = true;

    // WHEN the indicator renders without usage
    const { container } = render(
      <ContextWindowIndicator usage={null} assistantName="Vellum" />,
    );

    // THEN there is nothing to show
    expect(container.firstChild).toBeNull();
  });
});
