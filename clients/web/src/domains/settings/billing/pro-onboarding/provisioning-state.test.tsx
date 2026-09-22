/**
 * Tests for the pure-props `ProvisioningState` takeover. Renders via
 * `@testing-library/react` (happy-dom registered in test-setup.ts) wrapped in
 * a `QueryClientProvider`, so every phase is driven through props. The
 * character stream draws on a canvas happy-dom gives no context for, so it
 * mounts and draws nothing; its geometry has its own tests.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";

import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { PlanListResponse } from "@/generated/api/types.gen";

import {
  PROVISIONING_SURFACE,
  ProvisioningState,
  type ProvisioningStateProps,
} from "./provisioning-state";

afterEach(() => {
  cleanup();
});

function baseProps(
  overrides: Partial<ProvisioningStateProps> = {},
): ProvisioningStateProps {
  return {
    state: "CONFIRMING",
    softWaiting: false,
    intent: null,
    targets: { machineSize: null, storageGib: null },
    fromSnapshot: { machineSize: null, storageGib: null },
    celebrating: false,
    onCelebrationEnd: () => {},
    escapeAvailable: false,
    onEscape: () => {},
    confirm: { onRetry: () => {}, onGoToBilling: () => {} },
    ...overrides,
  };
}

/** A pro catalog with a `credits_50` tier and a Mighty package that maps to it. */
function plansResponse(): PlanListResponse {
  return {
    plans: [
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [],
        storage_tiers: [],
        credit_tiers: [
          {
            tier: "credits_50",
            label: "Mighty Usage",
            credits_usd: 50,
            price_cents: 5000,
            lookup_key: "credits_50_key",
            legacy: false,
          },
        ],
        packages: [
          {
            key: "mighty",
            name: "Mighty",
            description: "",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_50",
            machine_size: null,
            storage_gib: 10,
            credits_usd: 50,
            usage_label: "Mighty Usage",
            include_platform_fee: false,
            base_price_cents: 4000,
            machine_price_cents: 0,
            storage_price_cents: 0,
            credit_price_cents: 0,
            total_price_cents: 4000,
          },
        ],
      },
    ],
  };
}

/**
 * Renders the takeover with the plan catalog seeded into the query cache so the
 * credits hook resolves without a fetch. Pass `plans: null` to leave it
 * unresolved (credits omitted).
 */
function renderState(
  overrides: Partial<ProvisioningStateProps> = {},
  plans: PlanListResponse | null = plansResponse(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (plans) {
    client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  }
  return render(
    <QueryClientProvider client={client}>
      <ProvisioningState {...baseProps(overrides)} />
    </QueryClientProvider>,
  );
}

/** Matches the dimension chips, not the check/spinner testids inside them. */
const CHIP_TESTID = /^chip-(machine|storage|credits)$/;

/** The resource chip row, asserting on the way that there is exactly one. */
function chipRow(container: HTMLElement): HTMLElement {
  const rows = container.querySelectorAll<HTMLElement>(
    '[data-testid="resource-chips"]',
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

describe("confirming", () => {
  test("renders the confirming status line and caption", () => {
    const { getByText } = renderState({ state: "CONFIRMING" });

    expect(getByText("Confirming your upgrade…")).toBeTruthy();
    expect(getByText("This might take a couple seconds.")).toBeTruthy();
  });

  test("renders the package from the stashed intent", () => {
    const { getByTestId } = renderState({
      state: "CONFIRMING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
    });

    const column = getByTestId("chip-package");
    expect(within(column).getByText("Package")).toBeTruthy();
    expect(within(column).getByText("Mighty")).toBeTruthy();
    // Target-only: nothing to arrow from, and no progress to claim.
    expect(column.querySelector(".lucide-arrow-right")).toBeNull();
    expect(within(column).queryByTestId("chip-check")).toBeNull();
  });

  test("renders custom-intent machine/storage chips, target-only with no from-arrow, omitting credits when null", () => {
    const { getByText, queryByText, container } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "large",
        storageTier: "xl",
        creditTier: null,
        savedAt: Date.now(),
      },
    });

    expect(getByText("Machine")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("XL")).toBeTruthy();
    expect(queryByText(/credits/)).toBeNull();
    // CONFIRMING is target-only: no current→new arrow while actuals are unknown.
    expect(container.querySelector(".lucide-arrow-right")).toBeNull();
  });
});

describe("waiting / resizing", () => {
  test("renders the upgrading status with machine and storage from→to chips", () => {
    const { getByText, container } = renderState({
      state: "WAITING",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(getByText("Upgrading your assistant…")).toBeTruthy();
    expect(getByText("Machine")).toBeTruthy();
    expect(getByText("Small")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("30 GB")).toBeTruthy();
    expect(getByText("100 GB")).toBeTruthy();
    // Both changed dimensions show together, each with a current→new arrow.
    expect(container.querySelector(".lucide-arrow-right")).toBeTruthy();
  });

  test("storage-only targets render a single storage chip and no machine chip", () => {
    const { getByText, queryByText } = renderState({
      state: "RESIZING",
      targets: { machineSize: null, storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(getByText("Upgrading your assistant…")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(queryByText("Machine")).toBeNull();
  });

  test("softWaiting swaps in the softened sub-copy", () => {
    const { getByText, rerender } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
    });

    expect(getByText("This might take a couple seconds.")).toBeTruthy();

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    rerender(
      <QueryClientProvider client={client}>
        <ProvisioningState
          {...baseProps({
            state: "WAITING",
            softWaiting: true,
            targets: { machineSize: "medium", storageGib: null },
          })}
        />
      </QueryClientProvider>,
    );
    expect(
      getByText("Still working. This can take a minute or two."),
    ).toBeTruthy();
  });

  test("omits the credits chip while the catalog has not resolved", () => {
    const { queryByTestId } = renderState(
      {
        state: "WAITING",
        intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
        targets: { machineSize: null, storageGib: null },
        fromSnapshot: { machineSize: null, storageGib: null },
      },
      null,
    );

    expect(queryByTestId("chip-credits")).toBeNull();
  });

  test("machine + storage + credits share one row", () => {
    // Three columns are always all on screen, never one at a time, so a
    // downgrade can't hide the resize being waited on behind a dimension that
    // was never in doubt.
    const { container, getByText } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(getByText("Machine")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("100 GB")).toBeTruthy();
    expect(getByText("Usage")).toBeTruthy();
    expect(getByText("Mighty Usage")).toBeTruthy();
    // One row holds all three; there is no sibling row to wrap onto.
    const row = chipRow(container);
    expect(within(row).getAllByTestId(CHIP_TESTID).length).toBe(3);
  });

  test("a machine-less target renders the floor downsize it settles at", () => {
    const { getByTestId } = renderState({
      state: "WAITING",
      targets: { machineSize: null, storageGib: 100 },
      fromSnapshot: { machineSize: "medium", storageGib: 30 },
      machineFloor: "small",
    });

    const chip = getByTestId("chip-machine");
    expect(chip.textContent).toContain("Medium");
    expect(chip.textContent).toContain("Small");
  });
});

/** A machine + storage upgrade mid-resize, with nothing landed yet. */
const IN_FLIGHT: Partial<ProvisioningStateProps> = {
  state: "WAITING",
  targets: { machineSize: "large", storageGib: 100 },
  fromSnapshot: { machineSize: "small", storageGib: 30 },
};

describe("per-dimension progress", () => {
  test("every dimension starts pending, with no check", () => {
    const { getByTestId } = renderState(IN_FLIGHT);

    for (const key of ["chip-machine", "chip-storage"]) {
      const chip = getByTestId(key);
      expect(within(chip).queryByTestId("chip-check")).toBeNull();
      expect(within(chip).queryByTestId("chip-check")).toBeNull();
    }
  });

  test("a landed dimension checks off while the other stays pending", () => {
    const { getByTestId } = renderState({
      ...IN_FLIGHT,
      landed: { machine: false, storage: true },
    });

    const storage = getByTestId("chip-storage");
    expect(within(storage).getByTestId("chip-check")).toBeTruthy();
    // The landed chip keeps its from→to arrow rather than collapsing to the
    // achieved value.
    expect(storage.textContent).toContain("30 GB");
    expect(storage.textContent).toContain("100 GB");

    const machine = getByTestId("chip-machine");
    expect(within(machine).queryByTestId("chip-check")).toBeNull();
    expect(within(machine).queryByTestId("chip-check")).toBeNull();
  });

  test("the credits column is landed from first paint", () => {
    // The rate flips when the plan change is accepted; nothing rolls out, so
    // waiting on the machine would leave it pending for no reason.
    const { getByTestId } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: null },
      landed: { machine: false, storage: false },
    });

    expect(
      within(getByTestId("chip-credits")).getByTestId("chip-check"),
    ).toBeTruthy();
    expect(
      within(getByTestId("chip-machine")).queryByTestId("chip-check"),
    ).toBeNull();
  });

  test("stalled keeps each column on its own dimension's state", () => {
    const { getByTestId } = renderState({
      state: "STALLED",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      landed: { machine: false, storage: true },
    });

    expect(
      within(getByTestId("chip-storage")).getByTestId("chip-check"),
    ).toBeTruthy();
    expect(
      within(getByTestId("chip-machine")).queryByTestId("chip-check"),
    ).toBeNull();
  });

  test("a mixed row reads its progress per dimension, not just paints it", () => {
    // The check is invisible to assistive tech, so without the status text a
    // landed storage sounds identical to a pending one.
    const { getByTestId } = renderState({
      ...IN_FLIGHT,
      landed: { machine: false, storage: true },
    });

    const storage = within(getByTestId("chip-storage"));
    expect(storage.getByText("Complete").className).toContain("sr-only");
    expect(storage.queryByText("Pending")).toBeNull();

    const machine = within(getByTestId("chip-machine"));
    expect(machine.getByText("Pending").className).toContain("sr-only");
    expect(machine.queryByText("Complete")).toBeNull();
  });

  test("a dimension arriving mid-wait announces itself by name", () => {
    // Discoverable `sr-only` text is silent on change, so a user who stays on
    // the takeover hears nothing when a dimension arrives without the region.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      organizationsBillingPlansRetrieveQueryKey(),
      plansResponse(),
    );
    const tree = (landed: { machine: boolean; storage: boolean }) => (
      <QueryClientProvider client={client}>
        <ProvisioningState {...baseProps({ ...IN_FLIGHT, landed })} />
      </QueryClientProvider>
    );

    const { getByTestId, rerender } = render(
      tree({ machine: false, storage: false }),
    );
    expect(getByTestId("chip-announcement").textContent).toBe("");

    rerender(tree({ machine: false, storage: true }));

    const announced = getByTestId("chip-announcement").textContent ?? "";
    expect(announced).toContain("Storage");
    expect(announced).toContain("complete");
  });

  test("what already reads complete at first paint stays silent", () => {
    // A dimension that settled before the takeover opened, and credits which
    // carry no wait at all, have no arrival to report. Announcing them on mount
    // would claim progress the user never waited through.
    const { getByTestId } = renderState({
      ...IN_FLIGHT,
      landed: { machine: false, storage: true },
    });

    expect(
      within(getByTestId("chip-storage")).getByText("Complete"),
    ).toBeTruthy();
    expect(getByTestId("chip-announcement").textContent).toBe("");
  });

  test("the from-to relation is spoken rather than left to the arrow glyph", () => {
    // The arrow is aria-hidden, so the column would otherwise read
    // "Machine Small Large Pending".
    const { getByTestId } = renderState(IN_FLIGHT);

    expect(
      within(getByTestId("chip-machine")).getByText("to").className,
    ).toContain("sr-only");
  });

  test("a target-only intent column claims neither status", () => {
    // CONFIRMING has no per-dimension progress to report, so claiming
    // "Pending" there would assert a resize that isn't in flight.
    const { getByText, queryByText } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "large",
        storageTier: null,
        creditTier: null,
        savedAt: Date.now(),
      },
    });

    expect(getByText("Machine")).toBeTruthy();
    expect(queryByText("Pending")).toBeNull();
    expect(queryByText("Complete")).toBeNull();
  });
});

describe("done / not_applicable", () => {
  test("done renders the all-done status, checked columns, and fires onCelebrationEnd after the dwell", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "DONE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      // The state itself is the signal here, so a dimension the hook never got
      // to report still reads done.
      landed: { machine: false, storage: false },
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("All done!")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("100 GB")).toBeTruthy();
    // One format everywhere: the terminal phase keeps the from→to arrow and
    // adds the check.
    for (const key of ["chip-machine", "chip-storage"]) {
      expect(within(getByTestId(key)).getByTestId("chip-check")).toBeTruthy();
    }
    expect(getByText("Small")).toBeTruthy();
    expect(getByText("30 GB")).toBeTruthy();
    await waitFor(() => expect(onCelebrationEnd).toHaveBeenCalledTimes(1));
  });

  test("done does not fire onCelebrationEnd when not celebrating", async () => {
    const onCelebrationEnd = mock(() => {});
    renderState({
      state: "DONE",
      celebrating: false,
      onCelebrationEnd,
      dwellMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onCelebrationEnd).not.toHaveBeenCalled();
  });

  test("not_applicable renders the plan-ready status with nothing to show and no Apply button", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText, queryByText, queryByTestId } = renderState({
      state: "NOT_APPLICABLE",
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("Your plan is ready")).toBeTruthy();
    // No targets and no credit change, so the row has no chip to build.
    expect(queryByTestId("resource-chips")).toBeNull();
    expect(queryByText("Machine")).toBeNull();
    expect(queryByText("Storage")).toBeNull();
    expect(queryByTestId("provisioning-apply")).toBeNull();
    await waitFor(() => expect(onCelebrationEnd).toHaveBeenCalledTimes(1));
  });

  test("not_applicable carries the credits chip, checked, in the same format", () => {
    // A credit-only in-place change owes no resize, so it lands here, and this
    // is the one surface where it can state what changed.
    const { getByText, getByTestId } = renderState({
      state: "NOT_APPLICABLE",
      creditsChange: { fromTier: "credits_25", toTier: "credits_50" },
    });

    expect(getByText("Your plan is ready")).toBeTruthy();
    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("Mighty Usage");
    expect(within(chip).getByTestId("chip-check")).toBeTruthy();
  });

  test("not_applicable states the credit move alone, whatever the live targets carry", () => {
    // The provisioning targets carry the tier ceiling, so a Super/Ultra sub has
    // a non-null machine target even for a credit-only change. Nothing is being
    // provisioned in this phase, so only the credit move belongs on screen.
    const { getByTestId, queryByTestId } = renderState({
      state: "NOT_APPLICABLE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: null, storageGib: null },
      creditsChange: { fromTier: "credits_25", toTier: "credits_50" },
    });

    expect(getByTestId("chip-credits")).toBeTruthy();
    expect(queryByTestId("chip-machine")).toBeNull();
    expect(queryByTestId("chip-storage")).toBeNull();
  });

  test("not_applicable with nothing but resource targets renders no row at all", () => {
    const { queryByTestId } = renderState({
      state: "NOT_APPLICABLE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    expect(queryByTestId("resource-chips")).toBeNull();
  });

  test("done still renders the resource chips alongside credits", () => {
    // The credits-only narrowing is scoped to NOT_APPLICABLE; DONE reports the
    // provisioning that actually ran.
    const { getByTestId } = renderState({
      state: "DONE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      creditsChange: { fromTier: "credits_25", toTier: "credits_50" },
    });

    expect(getByTestId("chip-machine")).toBeTruthy();
    expect(getByTestId("chip-storage")).toBeTruthy();
    expect(getByTestId("chip-credits")).toBeTruthy();
  });

  test("done carries the credits chip alongside the resource chips", () => {
    const { getByText, getByTestId } = renderState({
      state: "DONE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      creditsChange: { fromTier: null, toTier: "credits_50" },
    });

    expect(getByText("All done!")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("No extra usage");
    expect(chip.textContent).toContain("Mighty Usage");
  });
});

describe("stalled", () => {
  test("with no captured error shows the honest taking-longer copy, chips, and the background button — never an Apply", () => {
    const onEscape = mock(() => {});
    const { getByText, queryByTestId, getByTestId } = renderState({
      state: "STALLED",
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: null },
      escapeAvailable: true,
      onEscape,
    });

    expect(getByText("This is taking longer than expected")).toBeTruthy();
    expect(getByText("This may take a couple of minutes.")).toBeTruthy();
    expect(getByText("Machine")).toBeTruthy();
    // The takeover renders no Apply & Restart control in any phase.
    expect(queryByTestId("provisioning-apply")).toBeNull();
    expect(getByText("Continue in the background")).toBeTruthy();
    fireEvent.click(getByTestId("provisioning-escape"));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("with a captured reconcile error shows the snag copy, the mapped error, and a Retry-in-background button", () => {
    const { getByText, queryByTestId } = renderState({
      state: "STALLED",
      escapeAvailable: true,
      kickError: { detail: "Resize already in progress." },
    });

    expect(getByText("We hit a snag upgrading your assistant")).toBeTruthy();
    expect(getByText("Resize already in progress.")).toBeTruthy();
    expect(queryByTestId("provisioning-apply")).toBeNull();
    expect(getByText("Retry in the background")).toBeTruthy();
  });

  test("the background button relabels to Retry once a reconcile has errored", () => {
    const { getByText, queryByText, rerender } = renderState({
      state: "STALLED",
      escapeAvailable: true,
    });

    expect(getByText("Continue in the background")).toBeTruthy();
    expect(queryByText("Retry in the background")).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProvisioningState
          {...baseProps({
            state: "STALLED",
            escapeAvailable: true,
            kickError: { error: "provisioning_submission_failed" },
          })}
        />
      </QueryClientProvider>,
    );

    expect(getByText("Retry in the background")).toBeTruthy();
    expect(queryByText("Continue in the background")).toBeNull();
  });

  test("an unchanged machine dimension drops out while storage still arrows", () => {
    const { getByText, queryByTestId, container } = renderState({
      state: "STALLED",
      targets: { machineSize: "medium", storageGib: 100 },
      fromSnapshot: { machineSize: "medium", storageGib: 30 },
    });

    // The pod is already at the target size, so nothing is being resized there
    // and the chip would claim work that never runs.
    expect(queryByTestId("chip-machine")).toBeNull();
    // Storage changed: both endpoints render, with a single from→to arrow.
    expect(getByText("30 GB")).toBeTruthy();
    expect(getByText("100 GB")).toBeTruthy();
    expect(container.querySelectorAll(".lucide-arrow-right").length).toBe(1);
  });

  test("an unchanged machine and unchanged storage leave no chip row", () => {
    const { queryByText, queryByTestId } = renderState({
      state: "STALLED",
      targets: { machineSize: "medium", storageGib: 30 },
      fromSnapshot: { machineSize: "medium", storageGib: 30 },
    });

    expect(queryByTestId("resource-chips")).toBeNull();
    expect(queryByText("Machine")).toBeNull();
    // Storage only renders when it grows, so an unchanged tier has no chip.
    expect(queryByText("Storage")).toBeNull();
  });
});

describe("confirm_timeout", () => {
  test("renders the still-confirming reassurance with retry and billing actions", () => {
    const onRetry = mock(() => {});
    const onGoToBilling = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "CONFIRM_TIMEOUT",
      confirm: { onRetry, onGoToBilling },
    });

    expect(getByText("Still confirming your upgrade")).toBeTruthy();
    expect(
      getByText("Your payment went through safely. This can take a minute."),
    ).toBeTruthy();
    fireEvent.click(getByTestId("onboarding-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("onboarding-go-to-billing"));
    expect(onGoToBilling).toHaveBeenCalledTimes(1);
  });
});

describe("direction", () => {
  test("a downgrade never claims an upgrade in any phase", () => {
    const phases: Array<[ProvisioningStateProps["state"], string]> = [
      ["CONFIRMING", "Confirming your plan change…"],
      ["WAITING", "Updating your assistant…"],
      ["RESIZING", "Updating your assistant…"],
      ["CONFIRM_TIMEOUT", "Still confirming your plan change"],
    ];
    for (const [state, expected] of phases) {
      const { getByText, unmount } = renderState({
        state,
        direction: "downgrade",
        targets: { machineSize: "small", storageGib: null },
        fromSnapshot: { machineSize: "medium", storageGib: null },
      });
      expect(getByText(expected)).toBeTruthy();
      unmount();
    }
  });

  test("a downgrade confirm timeout reassures without claiming a payment", () => {
    // A net package decrease is credited against the next invoice, so nothing
    // may have been charged at all.
    const { getByText, queryByText } = renderState({
      state: "CONFIRM_TIMEOUT",
      direction: "downgrade",
    });

    expect(
      getByText("Your plan change was submitted. This can take a minute."),
    ).toBeTruthy();
    expect(queryByText(/payment/i)).toBeNull();
  });

  test("a downgrade snag reads as a plan change, error message and all", () => {
    const { getByText } = renderState({
      state: "STALLED",
      direction: "downgrade",
      escapeAvailable: true,
      kickError: {},
    });

    expect(getByText("We hit a snag updating your assistant")).toBeTruthy();
    expect(
      getByText(
        "Retry in the background and we'll keep working on your plan change.",
      ),
    ).toBeTruthy();
  });

  test("a direction-unknown change reads the same as a downgrade", () => {
    const { getByText } = renderState({
      state: "WAITING",
      direction: "change",
    });
    expect(getByText("Updating your assistant…")).toBeTruthy();
  });

  test("an omitted direction keeps the upgrade wording", () => {
    const { getByText } = renderState({ state: "WAITING" });
    expect(getByText("Upgrading your assistant…")).toBeTruthy();
  });
});

describe("escape hatch", () => {
  test("renders the background-continue button only when available", () => {
    const onEscape = mock(() => {});
    const { getByTestId } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
      escapeAvailable: true,
      onEscape,
    });

    fireEvent.click(getByTestId("provisioning-escape"));
    expect(onEscape).toHaveBeenCalledTimes(1);

    cleanup();
    const { queryByTestId } = renderState({
      state: "WAITING",
      targets: { machineSize: "medium", storageGib: null },
      escapeAvailable: false,
    });
    expect(queryByTestId("provisioning-escape")).toBeNull();
  });
});

describe("takeover surface", () => {
  test("paints white, whatever the theme, under light tokens, and mounts the stream", () => {
    const { getByTestId } = renderState({ state: "WAITING" });

    const root = getByTestId("provisioning-takeover");
    expect(root.style.backgroundColor).toBe(PROVISIONING_SURFACE);
    // Dark and velvet set the content colours near white, so the text and
    // hairlines on this ground read the light theme's tokens instead.
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(getByTestId("upgrade-stream")).toBeTruthy();
  });

  test("renders no Apply control in any phase", () => {
    for (const state of [
      "CONFIRMING",
      "WAITING",
      "DONE",
      "STALLED",
      "CONFIRM_TIMEOUT",
    ] as const) {
      const { queryByTestId, unmount } = renderState({ state });
      expect(queryByTestId("provisioning-apply")).toBeNull();
      unmount();
    }
  });
});

describe("ProvisioningState phase hold", () => {
  test("keeps a phase on screen for its minimum before the next one shows", async () => {
    const { rerender, getByText, queryByText } = renderState({
      state: "CONFIRMING",
      phaseMinMs: 150,
    });
    expect(getByText("Confirming your upgrade…")).toBeTruthy();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProvisioningState {...baseProps({ state: "DONE", phaseMinMs: 150 })} />
      </QueryClientProvider>,
    );
    // Still inside CONFIRMING's window, so DONE hasn't been allowed through.
    expect(queryByText("All done!")).toBeNull();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 1000,
    });
  });

  test("skips a phase that would resolve before it could be read", async () => {
    const { rerender, getByText, queryByText } = renderState({
      state: "CONFIRMING",
      phaseMinMs: 150,
    });

    const advance = (state: ProvisioningStateProps["state"]) =>
      rerender(
        <QueryClientProvider client={new QueryClient()}>
          <ProvisioningState {...baseProps({ state, phaseMinMs: 150 })} />
        </QueryClientProvider>,
      );

    // WAITING and DONE both land inside CONFIRMING's window; WAITING is never
    // readable, so it must never reach the screen.
    advance("WAITING");
    advance("DONE");
    expect(queryByText("Upgrading your assistant…")).toBeNull();

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(queryByText("Upgrading your assistant…")).toBeNull();
  });

  test("passes phases straight through when the hold is disabled", () => {
    const { rerender, getByText } = renderState({
      state: "CONFIRMING",
      phaseMinMs: 0,
    });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProvisioningState {...baseProps({ state: "DONE", phaseMinMs: 0 })} />
      </QueryClientProvider>,
    );
    expect(getByText("All done!")).toBeTruthy();
  });

  test("reports the phase on screen, not the live one", async () => {
    // The wizard locks Esc/backdrop against this report, so it has to describe
    // what the user is looking at — reporting DONE early unlocks the takeover
    // while it still reads as busy.
    const reported: string[] = [];
    const onPhaseChange = (phase: ProvisioningStateProps["state"]) => {
      reported.push(phase);
    };
    const { rerender, getByText } = renderState({
      state: "WAITING",
      phaseMinMs: 150,
      onPhaseChange,
    });
    expect(reported).toEqual(["WAITING"]);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProvisioningState
          {...baseProps({ state: "DONE", phaseMinMs: 150, onPhaseChange })}
        />
      </QueryClientProvider>,
    );
    expect(reported).toEqual(["WAITING"]);

    await waitFor(() => expect(getByText("All done!")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(reported).toEqual(["WAITING", "DONE"]);
  });
});

// ---------------------------------------------------------------------------
// The credits column names usage bundles, never a credit amount
// ---------------------------------------------------------------------------

describe("credits column wording", () => {
  test("the resize credits column names the bundles, not monthly rates", () => {
    const { getByTestId } = renderState({
      state: "WAITING",
      creditsChange: { fromTier: null, toTier: "credits_50" },
    });

    const chip = getByTestId("chip-credits");
    expect(within(chip).getByText("Usage")).toBeTruthy();
    expect(chip.textContent).toContain("No extra usage");
    expect(chip.textContent).toContain("Mighty Usage");
    expect(chip.textContent).not.toContain("$");
  });

  test("a dropped bundle reads down to the no-extra-usage sentinel", () => {
    const { getByTestId } = renderState({
      state: "NOT_APPLICABLE",
      creditsChange: { fromTier: "credits_50", toTier: null },
    });

    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("Mighty Usage");
    expect(chip.textContent).toContain("No extra usage");
    expect(chip.textContent).not.toContain("$");
  });

  test("a checkout credits chip reads as bundles too", () => {
    const { getByTestId, queryByText } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
    });

    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("No extra usage");
    expect(chip.textContent).toContain("Mighty Usage");
    expect(queryByText("$0/mo")).toBeNull();
    expect(queryByText("Credits")).toBeNull();
  });

  test("a from-side the catalog can't label is left unstated", () => {
    // credits_25 is absent from the fixture catalog: its key still resolves
    // an amount, but there is no wording to show for it.
    const { getByTestId } = renderState({
      state: "WAITING",
      creditsChange: { fromTier: "credits_25", toTier: "credits_50" },
    });

    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("Mighty Usage");
    expect(chip.textContent).not.toContain("25");
    expect(chip.querySelector(".lucide-arrow-right")).toBeNull();
  });

  test("a to-side the catalog can't label drops the chip, not the disguise", () => {
    const { queryByTestId } = renderState({
      state: "WAITING",
      creditsChange: { fromTier: "credits_50", toTier: "credits_25" },
    });

    expect(queryByTestId("chip-credits")).toBeNull();
  });

  test("the confirming custom-intent chip names the bundle, not a count", () => {
    const { getByText, queryByText } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "medium",
        storageTier: "s",
        creditTier: "credits_50",
        savedAt: Date.now(),
      },
    });

    expect(getByText("Mighty Usage")).toBeTruthy();
    expect(queryByText("50 credits")).toBeNull();
  });
});
