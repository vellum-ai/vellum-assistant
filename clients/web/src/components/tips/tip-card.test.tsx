/**
 * Tests for `TipCard` — the presentational tip card. The card is a bespoke
 * composition (no design-library Notice), so it renders directly inside a
 * `MemoryRouter` (it emits a react-router `<Link>` and navigates on
 * "Don't show again"), via `@testing-library/react` on happy-dom.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { TipCard } from "@/components/tips/tip-card";
import { routes } from "@/utils/routes";
import type { Tip } from "@/utils/tips-catalog";

const LINKED_TIP: Tip = {
  id: "what-are-skills",
  kind: "info",
  source: "curated",
  eyebrow: "Skills",
  title: "Learn new skills",
  body: "Install skills from the catalog to teach me new abilities.",
  learnMore: { label: "Browse skills", to: routes.skills.root },
};

const PLAIN_TIP: Tip = {
  id: "app-builder",
  kind: "info",
  source: "curated",
  eyebrow: "Apps",
  title: "Build personal tools",
  body: "Ask me for a tracker, dashboard, or calculator.",
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderCard(
  tip: Tip,
  handlers?: Partial<{
    onDismiss: () => void;
    onLearnMore: () => void;
    onDontShowAgain: () => void;
  }>,
) {
  return render(
    <MemoryRouter initialEntries={[routes.assistant]}>
      <TipCard
        tip={tip}
        onDismiss={handlers?.onDismiss ?? (() => {})}
        onLearnMore={handlers?.onLearnMore ?? (() => {})}
        onDontShowAgain={handlers?.onDontShowAgain ?? (() => {})}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("TipCard", () => {
  test("renders the eyebrow, title, and body", () => {
    const { getByText, container } = renderCard(LINKED_TIP);

    expect(container.querySelector('[data-slot="tip-card"]')).not.toBeNull();
    expect(getByText(LINKED_TIP.eyebrow)).not.toBeNull();
    expect(getByText(LINKED_TIP.title)).not.toBeNull();
    expect(getByText(LINKED_TIP.body)).not.toBeNull();
  });

  test("renders the learn-more link with the catalog label, arrow, and target", () => {
    const onLearnMore = mock(() => {});
    const { getByText } = renderCard(LINKED_TIP, { onLearnMore });

    const link = getByText("Browse skills →").closest("a");
    expect(link?.getAttribute("href")).toBe(routes.skills.root);

    fireEvent.click(getByText("Browse skills →"));
    expect(onLearnMore).toHaveBeenCalledTimes(1);
  });

  test("omits the learn-more link for tips without one", () => {
    const { container, getByText } = renderCard(PLAIN_TIP);

    expect(container.querySelector("a")).toBeNull();
    expect(getByText("Don't show again")).not.toBeNull();
  });

  test("dismisses through the header X button", () => {
    const onDismiss = mock(() => {});
    const { getByLabelText } = renderCard(LINKED_TIP, { onDismiss });

    fireEvent.click(getByLabelText("Dismiss"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("don't show again fires the callback and navigates to Settings General", () => {
    const onDontShowAgain = mock(() => {});
    const { getByText, getByTestId } = renderCard(LINKED_TIP, {
      onDontShowAgain,
    });

    fireEvent.click(getByText("Don't show again"));

    expect(onDontShowAgain).toHaveBeenCalledTimes(1);
    expect(getByTestId("location").textContent).toBe(routes.settings.general);
  });
});
