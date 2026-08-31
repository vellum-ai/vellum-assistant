/**
 * Tests for the pure-props `ProvisioningState` takeover. Renders via
 * `@testing-library/react` (happy-dom registered in test-setup.ts) wrapped in
 * a `QueryClientProvider`. The takeover avatar hook is mocked to record the id
 * it's queried with — the avatar resolves to its neutral fallback (null
 * components) — so every phase stays driven through props while the
 * avatar-target wiring can be asserted directly.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import * as motionReact from "motion/react";

import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { PlanListResponse } from "@/generated/api/types.gen";
import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SURFACE_GROUND } from "@/utils/avatar-tone";

import type { ProvisioningStateProps } from "./provisioning-state";

/** The id handed to the avatar hook, captured so the target-selection wiring
 *  can be asserted without a network fetch. */
let avatarQueryId: string | null | undefined;
/** Flipped per-test to hold the avatar query in flight. */
let avatarLoading = false;
/** The avatar the mocked query resolves to; null components keep the neutral
 *  fallback the phase/mode cases render against. */
let avatarComponents: CharacterComponents | null = null;
let avatarTraits: CharacterTraits | null = null;
/** An uploaded avatar image, which the takeover also blurs behind its content. */
let avatarCustomImageUrl: string | null = null;
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: (assistantId: string | null) => {
    avatarQueryId = assistantId;
    return {
      components: avatarComponents,
      traits: avatarTraits,
      customImageUrl: avatarCustomImageUrl,
      isLoading: avatarLoading,
      invalidate: () => {},
    };
  },
}));

// `useReducedMotion` reads a cached media-query singleton, so a per-test
// `matchMedia` stub can't flip it. Override just that export (real `motion` /
// `AnimatePresence` are preserved) and drive it through this toggle instead.
let reducedMotion = false;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const { ProvisioningState, TAKEOVER_SURFACE, TAKEOVER_SURFACE_VAR } =
  await import("./provisioning-state");

beforeEach(() => {
  avatarQueryId = undefined;
  avatarLoading = false;
  avatarComponents = null;
  avatarTraits = null;
  avatarCustomImageUrl = null;
  reducedMotion = false;
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

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

  test("renders a package chip from the stashed intent", () => {
    const { getByText } = renderState({
      state: "CONFIRMING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
    });

    expect(getByText("Mighty package")).toBeTruthy();
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

  test("renders a credits chip when the custom intent bundles credits", () => {
    const { getByText } = renderState({
      state: "CONFIRMING",
      intent: {
        kind: "custom",
        machineTier: "medium",
        storageTier: "s",
        creditTier: "credits_50",
        savedAt: Date.now(),
      },
    });

    expect(getByText("50 credits")).toBeTruthy();
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

  test("renders a checkout credits chip as a monthly rate from $0", () => {
    const { getByText } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
    });

    expect(getByText("Credits")).toBeTruthy();
    expect(getByText("$0/mo")).toBeTruthy();
    expect(getByText("$50/mo")).toBeTruthy();
  });

  test("an in-place credit change renders the same from-to rate, in either direction", () => {
    // One format for checkout and for a switch: the chip states the move, so a
    // downgrade reads as plainly as an upgrade.
    const { getByTestId } = renderState({
      state: "WAITING",
      creditsChange: { fromTier: "credits_50", toTier: "credits_25" },
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
    });

    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("$50/mo");
    expect(chip.textContent).toContain("$25/mo");
  });

  test("omits the credits chip when the catalog can't resolve a label", () => {
    const { queryByText } = renderState(
      {
        state: "WAITING",
        intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
        targets: { machineSize: null, storageGib: null },
        fromSnapshot: { machineSize: null, storageGib: null },
      },
      null,
    );

    expect(queryByText("Credits")).toBeNull();
  });

  for (const reduce of [false, true]) {
    const label = reduce ? "under reduced motion" : "under full motion";
    test(`${label}, machine + storage + credits share one row`, () => {
      // The row is motion-independent: three chips are always all on screen,
      // never one at a time, so a downgrade can't hide the resize being waited
      // on behind a dimension that was never in doubt.
      reducedMotion = reduce;
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
      expect(getByText("Credits")).toBeTruthy();
      expect(getByText("$50/mo")).toBeTruthy();
      // One row holds all three; there is no sibling row to wrap onto.
      const row = chipRow(container);
      expect(within(row).getAllByTestId(CHIP_TESTID).length).toBe(3);
    });
  }

  test("the row cap widens for a third chip and holds the mock's width for two", () => {
    // happy-dom performs no layout, so this is a smoke test on the class the
    // width comes from; the real single-row check is visual.
    const threeChips = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });
    expect(chipRow(threeChips.container).className).toContain("max-w-2xl");
    // Never a second row: the chips shrink inside the cap instead.
    expect(chipRow(threeChips.container).className).not.toContain("flex-wrap");

    cleanup();
    const twoChips = renderState({
      state: "WAITING",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });
    expect(chipRow(twoChips.container).className).toContain("max-w-sm");
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

describe("per-chip progress", () => {
  test("every chip starts pending with a spinner and no check", () => {
    const { getByTestId } = renderState(IN_FLIGHT);

    for (const key of ["chip-machine", "chip-storage"]) {
      const chip = getByTestId(key);
      expect(within(chip).getByTestId("chip-spinner")).toBeTruthy();
      expect(within(chip).queryByTestId("chip-check")).toBeNull();
      expect(chip.className).toContain("opacity-70");
    }
  });

  test("a landed dimension checks off while the other keeps spinning", () => {
    const { getByTestId } = renderState({
      ...IN_FLIGHT,
      landed: { machine: false, storage: true },
    });

    const storage = getByTestId("chip-storage");
    expect(within(storage).getByTestId("chip-check")).toBeTruthy();
    expect(within(storage).queryByTestId("chip-spinner")).toBeNull();
    expect(storage.className).not.toContain("opacity-70");
    // The landed chip keeps its from→to arrow rather than collapsing to the
    // achieved value.
    expect(storage.textContent).toContain("30 GB");
    expect(storage.textContent).toContain("100 GB");

    const machine = getByTestId("chip-machine");
    expect(within(machine).getByTestId("chip-spinner")).toBeTruthy();
    expect(within(machine).queryByTestId("chip-check")).toBeNull();
  });

  test("the credits chip is landed from first paint", () => {
    // The rate flips when the plan change is accepted; nothing rolls out, so
    // waiting on the machine would leave it spinning for no reason.
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
      within(getByTestId("chip-machine")).getByTestId("chip-spinner"),
    ).toBeTruthy();
  });

  test("the progress mark shares a line with the value it belongs to", () => {
    // The value row wraps so a long value can break rather than clip the chip,
    // and the mark is the last and smallest thing on that line, so it is what
    // wraps: it lands alone underneath and reads as belonging to nothing. It
    // has to travel with the destination value as one item.
    const { getByTestId } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: null },
      landed: { machine: false, storage: false },
    });

    for (const [chipId, markId] of [
      ["chip-credits", "chip-check"],
      ["chip-machine", "chip-spinner"],
    ] as const) {
      const chip = getByTestId(chipId);
      const mark = within(chip).getByTestId(markId);
      const group = mark.parentElement;
      // The wrapping row is the grandparent once the mark sits in its group.
      expect(group?.className).toContain("inline-flex");
      expect(group?.className).not.toContain("flex-wrap");
      // The destination value is inside that same unwrappable group.
      expect(group?.textContent).not.toBe("");
    }
  });

  test("stalled keeps each chip on its own dimension's state", () => {
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
      within(getByTestId("chip-machine")).getByTestId("chip-spinner"),
    ).toBeTruthy();
  });

  test("a mixed row reads its progress per dimension, not just paints it", () => {
    // The spinner, the check and the dimming are all invisible to assistive
    // tech, so without the status text a landed storage sounds identical to a
    // pending one.
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
    // The arrow is aria-hidden, so the chip would otherwise read
    // "Machine Small Large Pending".
    const { getByTestId } = renderState(IN_FLIGHT);

    expect(
      within(getByTestId("chip-machine")).getByText("to").className,
    ).toContain("sr-only");
  });

  test("a target-only intent chip claims neither status", () => {
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

describe("chip fit at narrow widths", () => {
  /** The widest row the takeover renders: all three dimensions at once. */
  const NARROW: Partial<ProvisioningStateProps> = {
    ...IN_FLIGHT,
    intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
  };

  test("chip text breaks inside a word so it can never spill into the next chip", () => {
    // happy-dom runs no layout, so this asserts the rule the no-clip behaviour
    // rests on. `min-w-0` lets the box shrink but an unbreakable word such as
    // "Machine" still sets a floor; `anywhere` (not `break-word`) is what feeds
    // the break opportunity into the min-content sizing a flex item measures
    // itself against.
    const { getByTestId } = renderState(NARROW);
    const cases: Array<[string, string, string]> = [
      ["chip-machine", "Machine", "Large"],
      ["chip-storage", "Storage", "100 GB"],
      ["chip-credits", "Credits", "$50/mo"],
    ];

    for (const [key, label, value] of cases) {
      const chip = within(getByTestId(key));
      // Label and value both sit under the rule, which inherits from the text
      // column rather than being repeated on each span.
      expect(chip.getByText(label).closest(".wrap-anywhere")).toBeTruthy();
      expect(chip.getByText(value).closest(".wrap-anywhere")).toBeTruthy();
    }
  });

  test("the decorative icon yields its column below the narrow breakpoint", () => {
    // 32px of icon and gap against roughly 37px of text width at 320px, for a
    // glyph that is aria-hidden and repeats what the label already says.
    const { getByTestId } = renderState(NARROW);
    const slot =
      getByTestId("chip-machine").querySelector(".lucide-cpu")?.parentElement;

    expect(slot?.className).toContain("hidden");
    expect(slot?.className).toContain("min-[420px]:flex");
  });
});

describe("done / not_applicable", () => {
  test("done renders the all-done status, checked chips, and fires onCelebrationEnd after the dwell", async () => {
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
      const chip = getByTestId(key);
      expect(within(chip).getByTestId("chip-check")).toBeTruthy();
      expect(within(chip).queryByTestId("chip-spinner")).toBeNull();
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
    expect(chip.textContent).toContain("$25/mo");
    expect(chip.textContent).toContain("$50/mo");
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

  test("not_applicable renders a dropped bundle as a move to $0", () => {
    // "No extra credits" is an endpoint of the change like any other, so the
    // chip prices it rather than falling back to a bare status word.
    const { getByTestId } = renderState({
      state: "NOT_APPLICABLE",
      creditsChange: { fromTier: "credits_50", toTier: null },
    });

    const chip = getByTestId("chip-credits");
    expect(chip.textContent).toContain("$50/mo");
    expect(chip.textContent).toContain("$0/mo");
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
    expect(chip.textContent).toContain("$0/mo");
    expect(chip.textContent).toContain("$50/mo");
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

describe("takeover avatar", () => {
  test("queries the avatar for the passed provisioning target assistant", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });
    renderState({ assistantId: "primary-assistant" });

    expect(avatarQueryId).toBe("primary-assistant");
  });

  test("falls back to the active-store assistant when no target is passed", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });
    renderState();

    expect(avatarQueryId).toBe("active-assistant");
  });
});

/** The takeover root, which publishes the tint, paints from it, and holds the
 *  backdrop and the content layered over it. */
function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".provision-surface-settle");
  if (!el) {
    throw new Error("takeover root not found");
  }
  return el;
}

describe("takeover surface", () => {
  test("paints from the published variable rather than a literal colour", () => {
    const { container } = renderState({ assistantId: "primary-assistant" });

    expect(root(container).style.backgroundColor).toBe(TAKEOVER_SURFACE);
  });

  test("a purple character publishes its own deep tint", () => {
    avatarComponents = BUNDLED_COMPONENTS;
    avatarTraits = { bodyShape: "blob", eyeStyle: "curious", color: "purple" };

    const { container } = renderState({ assistantId: "primary-assistant" });

    expect(
      root(container)
        .style.getPropertyValue(TAKEOVER_SURFACE_VAR)
        .toLowerCase(),
    ).toBe("#29202e");
  });

  test("an unresolved avatar holds the neutral ground", () => {
    // A hue committed before the query settles is the wrong assistant's, at
    // full-viewport scale.
    avatarLoading = true;
    avatarComponents = BUNDLED_COMPONENTS;
    avatarTraits = { bodyShape: "blob", eyeStyle: "curious", color: "purple" };

    const { container } = renderState({ assistantId: "primary-assistant" });

    expect(root(container).style.getPropertyValue(TAKEOVER_SURFACE_VAR)).toBe(
      SURFACE_GROUND,
    );
  });

  test("the default green creature keeps the takeover's established tint", () => {
    avatarComponents = BUNDLED_COMPONENTS;

    const { container } = renderState({ assistantId: "primary-assistant" });

    expect(
      root(container)
        .style.getPropertyValue(TAKEOVER_SURFACE_VAR)
        .toLowerCase(),
    ).toBe("#1d281d");
  });
});

describe("takeover backdrop", () => {
  test("a custom-image avatar blurs that image behind the takeover", () => {
    avatarCustomImageUrl = "blob:vellum/avatar-image";

    const { getByTestId } = renderState({ assistantId: "primary-assistant" });

    expect(
      getByTestId("takeover-backdrop")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("blob:vellum/avatar-image");
  });

  test("every layer beside the backdrop stacks above it", () => {
    // The backdrop is absolutely positioned, so it paints over any sibling left
    // in normal flow — the avatar and the phase block both have to be raised.
    avatarCustomImageUrl = "blob:vellum/avatar-image";

    const { container, getByTestId } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });
    const backdrop = getByTestId("takeover-backdrop");
    const content = Array.from(root(container).children).filter(
      (el) => el !== backdrop,
    );

    expect(content.length).toBeGreaterThan(0);
    for (const el of content) {
      expect(el.className).toContain("z-10");
    }
  });

  test("a character avatar gets the flat tint and no image layer", () => {
    avatarComponents = BUNDLED_COMPONENTS;
    avatarTraits = { bodyShape: "blob", eyeStyle: "curious", color: "purple" };

    const { queryByTestId } = renderState({ assistantId: "primary-assistant" });

    expect(queryByTestId("takeover-backdrop")).toBeNull();
  });

  test("withholds the backdrop until the avatar query settles", () => {
    // A backdrop that appears and then disappears is worse than one that
    // arrives late.
    avatarLoading = true;
    avatarCustomImageUrl = "blob:vellum/avatar-image";

    const { queryByTestId } = renderState({ assistantId: "primary-assistant" });

    expect(queryByTestId("takeover-backdrop")).toBeNull();
  });
});

describe("takeover avatar mode", () => {
  /** The mode is carried as a class on the avatar's outer element. */
  function modeClasses(container: HTMLElement): string {
    const el = container.querySelector(".provision-avatar-evolve");
    return el?.className ?? "";
  }

  const CASES: Array<[ProvisioningStateProps["state"], boolean, string]> = [
    ["CONFIRMING", false, ""],
    ["CONFIRM_TIMEOUT", false, ""],
    ["WAITING", false, "is-working"],
    ["RESIZING", false, "is-working"],
    ["WAITING", true, "is-settling"],
    ["RESIZING", true, "is-settling"],
    ["STALLED", false, "is-stalled"],
    ["DONE", false, "is-evolved"],
    ["NOT_APPLICABLE", false, "is-evolved"],
  ];

  for (const [state, softWaiting, expected] of CASES) {
    const label = softWaiting ? `${state} past the grace window` : state;
    test(`${label} renders ${expected || "no mode class"}`, () => {
      const { container } = renderState({
        state,
        softWaiting,
        assistantId: "primary-assistant",
      });
      const classes = modeClasses(container);

      if (expected) {
        expect(classes).toContain(expected);
      } else {
        for (const mode of [
          "is-working",
          "is-settling",
          "is-stalled",
          "is-evolved",
        ]) {
          expect(classes).not.toContain(mode);
        }
      }
    });
  }

  test("a downgrade inverts the resolve, and only a known one does", () => {
    // The stage reserves the grown height either way, so the step down waits at
    // that size and settles into the resting one. Ending taller than it started
    // would read as the opposite of the change the user just made.
    const down = renderState({
      state: "DONE",
      direction: "downgrade",
      assistantId: "primary-assistant",
    });
    expect(modeClasses(down.container)).toContain("is-downsizing");
    cleanup();

    // A move with no knowable direction must not claim one.
    for (const direction of ["upgrade", "change", undefined] as const) {
      const view = renderState({
        state: "DONE",
        direction,
        assistantId: "primary-assistant",
      });
      expect(modeClasses(view.container)).not.toContain("is-downsizing");
      cleanup();
    }
  });

  test("withholds the avatar until its query settles", () => {
    // `components ?? fallback` synthesizes traits from the first bundled entry
    // of each list, so drawing during the fetch shows a green blob regardless
    // of the assistant's real avatar.
    avatarLoading = true;

    const { container, getByTestId } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });

    expect(container.querySelector(".provision-avatar-reveal")).toBeNull();
    // The stage still reserves its height, so nothing moves when it arrives.
    expect(container.querySelector(".provision-avatar-stage")).toBeTruthy();
    // …and the placeholder breathes in the meantime rather than leaving a hole.
    expect(getByTestId("provision-avatar-placeholder").className).not.toContain(
      "is-resolved",
    );
  });

  test("renders exactly one placeholder", () => {
    const { container } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });

    expect(
      container.querySelectorAll(".provision-avatar-placeholder"),
    ).toHaveLength(1);
  });

  test("reveals the avatar once the target and the query both settle", () => {
    const { container, getByTestId } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });

    expect(container.querySelector(".provision-avatar-reveal")).toBeTruthy();
    // The placeholder fades out on the same beat the creature arrives on.
    expect(getByTestId("provision-avatar-placeholder").className).toContain(
      "is-resolved",
    );
  });

  test("keeps waiting while the target assistant is still unknown", () => {
    // `useAssistantAvatar(null)` is a disabled query, and a disabled query
    // reports `isLoading: false` with no data — so the id has to gate the
    // render too. The active assistant is deliberately set here: an explicit
    // null target must not fall back to it, or a multi-assistant org fades in
    // the active assistant before the provisioning primary resolves.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });

    const { container } = renderState({ state: "WAITING", assistantId: null });

    expect(container.querySelector(".provision-avatar-reveal")).toBeNull();
    expect(container.querySelector(".provision-avatar-stage")).toBeTruthy();
    // Nor should it fetch the wrong assistant's avatar on the way.
    expect(avatarQueryId).toBeNull();
  });

  test("holds the grow until there is an avatar to play it on", () => {
    // The phase can resolve before the avatar fetch does — the avatar is read
    // off the machine being restarted — and a grow that runs on an empty
    // wrapper leaves the creature to fade in already at its final scale.
    avatarLoading = true;

    const { container } = renderState({
      state: "DONE",
      assistantId: "primary-assistant",
    });

    expect(
      container.querySelector(".provision-avatar-evolve")?.className,
    ).not.toContain("is-evolved");
  });

  test("steps the creature down so a short viewport keeps the actions below it", () => {
    // The stage reserves the grown height, so a full-size creature needs about
    // 650px before the phase block — which carries the escape hatch and the
    // stalled retry — starts to clip out of the h-screen takeover.
    const original = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      value: 568,
      configurable: true,
    });

    const { container } = renderState({ state: "WAITING" });
    const el = container.querySelector<HTMLElement>(".provision-avatar-evolve");

    expect(el?.style.getPropertyValue("--provision-avatar-size")).toBe("132px");

    Object.defineProperty(window, "innerHeight", {
      value: original,
      configurable: true,
    });
  });

  test("uses the full size when the viewport has room for it", () => {
    const original = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      value: 900,
      configurable: true,
    });

    const { container } = renderState({ state: "WAITING" });
    const el = container.querySelector<HTMLElement>(".provision-avatar-evolve");

    expect(el?.style.getPropertyValue("--provision-avatar-size")).toBe("240px");

    Object.defineProperty(window, "innerHeight", {
      value: original,
      configurable: true,
    });
  });

  test("the grace window never softens a state that isn't waiting", () => {
    const { container } = renderState({
      state: "STALLED",
      softWaiting: true,
      assistantId: "primary-assistant",
    });

    expect(modeClasses(container)).toContain("is-stalled");
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
// obscure-credits flag: the chips name usage bundles, never a credit amount
// ---------------------------------------------------------------------------

/** Drives the `obscure-credits` client flag the way the app's LD sync does. */
function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

describe("obscure-credits flag", () => {
  beforeEach(() => {
    setObscureCredits(true);
  });

  afterEach(() => {
    setObscureCredits(false);
  });

  test("the resize credits chip names the bundles, not monthly rates", () => {
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
    // credits_25 is absent from the fixture catalog: its key still prices the
    // off-flag rate, but under the flag there is no wording to show for it.
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
