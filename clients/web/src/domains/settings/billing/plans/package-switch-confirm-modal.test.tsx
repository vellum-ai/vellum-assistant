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

import type { ProPackage } from "@/generated/api/types.gen";
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

const UPGRADE_CAPTION = "Billed monthly · prorated difference charged today";
const SWITCH_CAPTION =
  "Billed monthly · prorated difference charged today or credited next invoice";
const DOWNGRADE_CAPTION =
  "Billed monthly · prorated credit on your next invoice";
const DOWNGRADE_NOTE =
  "Your machine downsizes now and your storage stays. No refund.";

/** The Mighty catalog shape; override fields for another tier. */
function proPackage(overrides: Partial<ProPackage> = {}): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    description: "Small machine, 15 GB of storage, and $25 in monthly credits.",
    version: 1,
    machine_tier: null,
    storage_tier: "s",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 15,
    credits_usd: 25,
    include_platform_fee: true,
    base_price_cents: 2000,
    machine_price_cents: 0,
    storage_price_cents: 500,
    credit_price_cents: 2500,
    total_price_cents: 5000,
    ...overrides,
  };
}

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
        targetPackage={proPackage()}
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
    // The tagline is the dialog's description, so it also carries the
    // `aria-describedby` the old title-only dialog never had.
    const describedBy = getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "More capacity for consistent use.",
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
      targetPackage: proPackage({
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
