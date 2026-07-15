/**
 * Tests for `TipCard` — the presentational tip card. The design-library
 * `Notice` is mocked to a minimal stand-in exposing the same contract
 * (children, actions, tone, onDismiss), mirroring `nudge-chat-banner.test.tsx`;
 * the card renders inside a `MemoryRouter` (it emits a react-router `<Link>`
 * and navigates on "Don't show again"), via `@testing-library/react` on
 * happy-dom.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { routes } from "@/utils/routes";
import type { Tip } from "@/utils/tips-catalog";

mock.module("@vellumai/design-library", () => ({
  Notice: ({
    children,
    actions,
    tone,
    onDismiss,
  }: {
    children?: ReactNode;
    actions?: ReactNode;
    tone?: string;
    onDismiss?: () => void;
  }) => (
    <div data-testid="notice" data-tone={tone}>
      {children}
      {actions ? <div data-testid="notice-actions">{actions}</div> : null}
      {onDismiss ? (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} />
      ) : null}
    </div>
  ),
}));

const { TipCard } = await import("@/components/tips/tip-card");

const LINKED_TIP: Tip = {
  id: "what-are-skills",
  kind: "info",
  source: "curated",
  body: "Skills are how I learn new abilities.",
  learnMore: { label: "Browse skills", to: routes.skills.root },
};

const PLAIN_TIP: Tip = {
  id: "app-builder",
  kind: "info",
  source: "curated",
  body: "Ask me to build you a tracker or dashboard.",
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
  test("renders the tip body in a hint-tone notice", () => {
    const { getByText, getByTestId } = renderCard(LINKED_TIP);

    expect(getByText(LINKED_TIP.body)).not.toBeNull();
    expect(getByTestId("notice").getAttribute("data-tone")).toBe("hint");
  });

  test("renders the learn-more link with the catalog label and target", () => {
    const onLearnMore = mock(() => {});
    const { getByText } = renderCard(LINKED_TIP, { onLearnMore });

    const link = getByText("Browse skills").closest("a");
    expect(link?.getAttribute("href")).toBe(routes.skills.root);

    fireEvent.click(getByText("Browse skills"));
    expect(onLearnMore).toHaveBeenCalledTimes(1);
  });

  test("omits the learn-more link for tips without one", () => {
    const { container, getByText } = renderCard(PLAIN_TIP);

    expect(container.querySelector("a")).toBeNull();
    expect(getByText("Don't show again")).not.toBeNull();
  });

  test("forwards dismissal through the Notice close affordance", () => {
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
