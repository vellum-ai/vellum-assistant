/**
 * Tests for `PackageSwitchConfirmModal`. The dialog is pure layout over three
 * pure helpers, so the harness only has to mock the assistant-avatar query at
 * its module boundary — the header tile pulls it in transitively and there is
 * no active assistant to resolve in a test.
 *
 * Radix portals the dialog, so queries come off `render`'s `baseElement`
 * (document.body), not the mount container.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";

import {
  DOWNGRADE_CAPTION,
  DOWNGRADE_NOTE,
  SWITCH_CAPTION,
  UPGRADE_CAPTION,
} from "@/domains/settings/billing/plans/package-switch-copy";
import { PLAN_TIER_COPY } from "@/domains/settings/billing/plans/plans-copy";
import { makeProPackage } from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { PackageSwitchConfirmModal } =
  await import("./package-switch-confirm-modal");

const MIGHTY_DESCRIPTION =
  "Small machine, 15 GB of storage, and $25 in monthly credits.";

let onCancel = mock(() => {});
let onConfirm = mock(() => {});

function renderModal(
  props: Partial<ComponentProps<typeof PackageSwitchConfirmModal>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PackageSwitchConfirmModal
        open
        relation="upgrade"
        packageName="Mighty"
        targetPackage={makeProPackage()}
        pending={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onCancel = mock(() => {});
  onConfirm = mock(() => {});
  // No resolved assistant: the tile holds its square and draws nothing, which
  // keeps the avatar compositor out of the run.
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

afterEach(() => {
  cleanup();
});

describe("PackageSwitchConfirmModal", () => {
  test("an upgrade prices the target package and lists what it includes", () => {
    const { getByText, getByRole, getByTestId } = renderModal();

    getByRole("heading", { name: "Upgrade to Mighty" });
    // Moving up, the tagline renders as the dialog's description, so it is what
    // `aria-describedby` points at.
    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      PLAN_TIER_COPY.mighty.tagline,
    );
    getByText("$50/mo");
    getByText(UPGRADE_CAPTION);
    getByText("The plan includes");
    getByText("Small machine (2 vCPU, 3 GiB)");
    getByText("15 GB storage");
    getByText("$25 of bundled credits");
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      "Continue",
    );
  });

  test("a downgrade keeps the explicit destructive label and the no-refund note", () => {
    const { getByText, getByRole, getByTestId } = renderModal({
      relation: "downgrade",
    });

    getByRole("heading", { name: "Downgrade to Mighty" });
    getByText(DOWNGRADE_CAPTION);
    getByText(DOWNGRADE_NOTE);
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      "Downgrade to Mighty",
    );
  });

  test("a downgrade swaps the avatar for a warning glyph and drops the gains framing", () => {
    const { getByTestId, queryByTestId, getByText, queryByText } = renderModal({
      relation: "downgrade",
    });

    getByTestId("package-switch-warning-tile");
    expect(queryByTestId("assistant-avatar-tile")).toBeNull();
    getByText("Your plan will include");
    expect(queryByText("The plan includes")).toBeNull();
  });

  test("an upgrade keeps the friendly avatar header", () => {
    const { getByTestId, queryByTestId, getByText } = renderModal();

    getByTestId("assistant-avatar-tile");
    expect(queryByTestId("package-switch-warning-tile")).toBeNull();
    getByText("The plan includes");
  });

  test("the dialog opens focused on Cancel, not on the confirm", () => {
    const { getByRole, getByTestId } = renderModal({ relation: "downgrade" });

    expect(document.activeElement).toBe(
      getByRole("button", { name: "Cancel" }),
    );
    expect(document.activeElement).not.toBe(
      getByTestId("confirm-package-switch-button"),
    );

    cleanup();

    const upgrade = renderModal();
    expect(document.activeElement).toBe(
      upgrade.getByRole("button", { name: "Cancel" }),
    );
  });

  test("a package with no tier copy describes itself from the catalog", () => {
    const { getByRole, getByText } = renderModal({
      packageName: "Mega",
      targetPackage: makeProPackage({ key: "mega", name: "Mega" }),
    });

    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      MIGHTY_DESCRIPTION,
    );
    getByText(MIGHTY_DESCRIPTION);
  });

  test("a downgrade describes the target factually, never with its sales tagline", () => {
    const { getByRole, getByText, queryByText } = renderModal({
      relation: "downgrade",
    });

    // "Downgrade to Mighty" over "More capacity for consistent use." pitches the
    // tier the user is leaving. The catalog blurb states what they land on, and
    // still anchors `aria-describedby`.
    expect(queryByText(PLAN_TIER_COPY.mighty.tagline)).toBeNull();
    getByText(MIGHTY_DESCRIPTION);
    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      MIGHTY_DESCRIPTION,
    );
  });

  test("with nothing to describe the dialog carries no aria-describedby", () => {
    const { getByRole } = renderModal({
      packageName: "",
      targetPackage: null,
    });

    expect(getByRole("dialog").hasAttribute("aria-describedby")).toBe(false);
  });

  test("the downgrade safeguard note survives an unresolved target", () => {
    const { getByText, queryByText } = renderModal({
      relation: "downgrade",
      packageName: "Mighty",
      targetPackage: null,
    });

    getByText(DOWNGRADE_NOTE);
    expect(queryByText("Your plan will include")).toBeNull();
  });

  test("a direction-neutral switch names both proration outcomes", () => {
    const { getByText, getByRole, getByTestId, queryByText } = renderModal({
      relation: "switch",
    });

    getByRole("heading", { name: "Switch to Mighty" });
    getByText(SWITCH_CAPTION);
    expect(queryByText(DOWNGRADE_NOTE)).toBeNull();
    expect(getByTestId("confirm-package-switch-button").textContent).toBe(
      "Continue",
    );
  });

  test("tier copy with extra features appends them after the derived rows", () => {
    const { getByText, getAllByRole } = renderModal({
      packageName: "Super",
      targetPackage: makeProPackage({
        key: "super",
        name: "Super",
        machine_size: "medium",
        storage_gib: 30,
        credits_usd: 45,
        total_price_cents: 10000,
      }),
    });

    getByText("$100/mo");
    expect(getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Medium machine (2.5 vCPU, 5 GiB)",
      "30 GB storage",
      "$45 of bundled credits",
      "Assistant email and subdomain",
    ]);
  });

  test("an unresolved target renders the header and the actions only", () => {
    const { getByText, getByRole, getByTestId, queryByText } = renderModal({
      packageName: "",
      targetPackage: null,
    });

    getByRole("heading", { name: "Upgrade to" });
    getByTestId("assistant-avatar-tile");
    expect(queryByText("The plan includes")).toBeNull();
    expect(queryByText(UPGRADE_CAPTION)).toBeNull();
    expect(queryByText("15 GB storage")).toBeNull();
    getByTestId("confirm-package-switch-button");
    getByText("Cancel");
  });

  test("a pending change disables both actions", () => {
    const { getByTestId, getByRole } = renderModal({ pending: true });

    expect(
      (getByTestId("confirm-package-switch-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the actions call back to the parent, which owns the mutation", () => {
    const { getByTestId, getByRole } = renderModal();

    fireEvent.click(getByTestId("confirm-package-switch-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(0);

    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
