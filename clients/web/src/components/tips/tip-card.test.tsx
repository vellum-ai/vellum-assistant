/**
 * Tests for `TipCard` — the presentational tip card. The card is a bespoke
 * composition (no design-library Notice), so it renders directly inside a
 * `MemoryRouter` (it emits a react-router `<Link>` for learn-more), via
 * `@testing-library/react` on happy-dom.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

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

function renderCard(
  tip: Tip,
  overrides?: Partial<{
    carouselIndex: number;
    carouselCount: number;
    onDismiss: () => void;
    onLearnMore: () => void;
    onPrevTip: () => void;
    onNextTip: () => void;
  }>,
) {
  return render(
    <MemoryRouter initialEntries={[routes.assistant]}>
      <TipCard
        tip={tip}
        carouselIndex={overrides?.carouselIndex ?? 1}
        carouselCount={overrides?.carouselCount ?? 4}
        onDismiss={overrides?.onDismiss ?? (() => {})}
        onLearnMore={overrides?.onLearnMore ?? (() => {})}
        onPrevTip={overrides?.onPrevTip ?? (() => {})}
        onNextTip={overrides?.onNextTip ?? (() => {})}
      />
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
    const { container } = renderCard(PLAIN_TIP);

    expect(container.querySelector("a")).toBeNull();
  });

  test("dismisses through the header X button", () => {
    const onDismiss = mock(() => {});
    const { getByLabelText } = renderCard(LINKED_TIP, { onDismiss });

    fireEvent.click(getByLabelText("Dismiss"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("fires the carousel callbacks from the chevrons", () => {
    const onPrevTip = mock(() => {});
    const onNextTip = mock(() => {});
    const { getByLabelText } = renderCard(LINKED_TIP, { onPrevTip, onNextTip });

    fireEvent.click(getByLabelText("Previous tip"));
    fireEvent.click(getByLabelText("Next tip"));

    expect(onPrevTip).toHaveBeenCalledTimes(1);
    expect(onNextTip).toHaveBeenCalledTimes(1);
  });

  test("disables the back chevron on the first tip and forward on the last", () => {
    const first = renderCard(LINKED_TIP, { carouselIndex: 0, carouselCount: 4 });
    expect(
      first.getByLabelText("Previous tip").hasAttribute("disabled"),
    ).toBe(true);
    expect(first.getByLabelText("Next tip").hasAttribute("disabled")).toBe(
      false,
    );
    cleanup();

    const last = renderCard(LINKED_TIP, { carouselIndex: 3, carouselCount: 4 });
    expect(last.getByLabelText("Previous tip").hasAttribute("disabled")).toBe(
      false,
    );
    expect(last.getByLabelText("Next tip").hasAttribute("disabled")).toBe(true);
  });

  test("renders one dot per tip up to the window, then caps at five", () => {
    const small = renderCard(LINKED_TIP, { carouselIndex: 0, carouselCount: 3 });
    expect(
      small.container.querySelectorAll('[data-slot="tip-card-dots"] span')
        .length,
    ).toBe(3);
    cleanup();

    const large = renderCard(LINKED_TIP, {
      carouselIndex: 10,
      carouselCount: 20,
    });
    expect(
      large.container.querySelectorAll('[data-slot="tip-card-dots"] span')
        .length,
    ).toBe(5);
  });

  test("hides the carousel row entirely for a single-tip catalog", () => {
    const { container } = renderCard(LINKED_TIP, {
      carouselIndex: 0,
      carouselCount: 1,
    });

    expect(container.querySelector('[data-slot="tip-card-prev"]')).toBeNull();
    expect(container.querySelector('[data-slot="tip-card-next"]')).toBeNull();
    expect(container.querySelector('[data-slot="tip-card-dots"]')).toBeNull();
  });
});
