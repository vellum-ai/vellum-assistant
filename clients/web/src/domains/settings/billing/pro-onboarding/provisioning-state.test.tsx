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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as motionReact from "motion/react";

import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { PlanListResponse } from "@/generated/api/types.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import type { ProvisioningStateProps } from "./provisioning-state";

/** The id handed to the avatar hook, captured so the target-selection wiring
 *  can be asserted without a network fetch. */
let avatarQueryId: string | null | undefined;
/** Flipped per-test to hold the avatar query in flight. */
let avatarLoading = false;
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: (assistantId: string | null) => {
    avatarQueryId = assistantId;
    return {
      components: null,
      traits: null,
      customImageUrl: null,
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

const { ProvisioningState } = await import("./provisioning-state");

beforeEach(() => {
  avatarQueryId = undefined;
  avatarLoading = false;
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
    stalledAction: { onApply: () => {}, pending: false, error: null },
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
            label: "$50 credits/mo",
            credits_usd: 50,
            price_cents: 5000,
            lookup_key: "credits_50_key",
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
    // Two changed dimensions (≤ MAX_CHIPS_IN_ROW) show together, each with a
    // current→new arrow.
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
      getByText("Still working — this can take a minute or two."),
    ).toBeTruthy();
  });

  test("renders a 0 → label credits chip when the catalog resolves a label", () => {
    const { getByText } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
    });

    expect(getByText("Credits")).toBeTruthy();
    expect(getByText("0")).toBeTruthy();
    expect(getByText("$50 credits/mo")).toBeTruthy();
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

  test("under reduced motion, machine + storage + credits all render together", () => {
    reducedMotion = true;
    const { getByText } = renderState({
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
    expect(getByText("$50 credits/mo")).toBeTruthy();
  });

  test("under full motion, three changes rotate — only the first chip renders", () => {
    reducedMotion = false;
    const { getByText, queryByText } = renderState({
      state: "WAITING",
      intent: { kind: "package", packageKey: "mighty", savedAt: Date.now() },
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
    });

    // Rotation starts at the machine change; storage/credits are off-screen.
    expect(getByText("Machine")).toBeTruthy();
    expect(queryByText("Storage")).toBeNull();
    expect(queryByText("Credits")).toBeNull();
  });
});

describe("done / not_applicable", () => {
  test("done renders the all-done status, target chips, and fires onCelebrationEnd after the dwell", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText } = renderState({
      state: "DONE",
      targets: { machineSize: "large", storageGib: 100 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("All done!")).toBeTruthy();
    expect(getByText("Large")).toBeTruthy();
    expect(getByText("100 GB")).toBeTruthy();
    // The "from" side is dropped once done — only the achieved target shows.
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

  test("not_applicable renders the plan-ready status without chips or an Apply button", async () => {
    const onCelebrationEnd = mock(() => {});
    const { getByText, queryByText, queryByTestId } = renderState({
      state: "NOT_APPLICABLE",
      celebrating: true,
      onCelebrationEnd,
      dwellMs: 10,
    });

    expect(getByText("Your plan is ready")).toBeTruthy();
    expect(queryByText("Machine")).toBeNull();
    expect(queryByText("Storage")).toBeNull();
    expect(queryByTestId("provisioning-apply")).toBeNull();
    await waitFor(() => expect(onCelebrationEnd).toHaveBeenCalledTimes(1));
  });
});

describe("stalled", () => {
  test("renders the stalled status, keeps the chips, and Apply & Restart invokes the callback", () => {
    const onApply = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "STALLED",
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: null },
      stalledAction: { onApply, pending: false, error: null },
    });

    expect(getByText("We couldn't finish this automatically")).toBeTruthy();
    expect(
      getByText("Apply the changes below to finish setting up your upgrade."),
    ).toBeTruthy();
    expect(getByText("Machine")).toBeTruthy();
    fireEvent.click(getByTestId("provisioning-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  test("disables the Apply button while pending and renders the extracted error as the caption", () => {
    const onApply = mock(() => {});
    const { getByText, getByTestId } = renderState({
      state: "STALLED",
      stalledAction: {
        onApply,
        pending: true,
        error: { detail: "Resize already in progress." },
      },
    });

    expect(getByText("Resize already in progress.")).toBeTruthy();
    const apply = getByTestId("provisioning-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
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
      getByText("Your payment went through safely — this can take a minute."),
    ).toBeTruthy();
    fireEvent.click(getByTestId("onboarding-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("onboarding-go-to-billing"));
    expect(onGoToBilling).toHaveBeenCalledTimes(1);
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

  test("withholds the avatar until its query settles", () => {
    // `components ?? fallback` synthesizes traits from the first bundled entry
    // of each list, so drawing during the fetch shows a green blob regardless
    // of the assistant's real avatar.
    avatarLoading = true;

    const { container } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });

    expect(container.querySelector(".provision-avatar-reveal")).toBeNull();
    // The stage still reserves its height, so nothing moves when it arrives.
    expect(container.querySelector(".provision-avatar-stage")).toBeTruthy();
  });

  test("reveals the avatar once the target and the query both settle", () => {
    const { container } = renderState({
      state: "WAITING",
      assistantId: "primary-assistant",
    });

    expect(container.querySelector(".provision-avatar-reveal")).toBeTruthy();
  });

  test("keeps waiting while the target assistant is still unknown", () => {
    // `useAssistantAvatar(null)` is a disabled query, and a disabled query
    // reports `isLoading: false` with no data — so the id has to gate the
    // render too. On a cold Stripe return both the onboarding primary and the
    // active-store id are null for a beat.
    useResolvedAssistantsStore.setState({ activeAssistantId: null });

    const { container } = renderState({ state: "WAITING", assistantId: null });

    expect(container.querySelector(".provision-avatar-reveal")).toBeNull();
    expect(container.querySelector(".provision-avatar-stage")).toBeTruthy();
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
