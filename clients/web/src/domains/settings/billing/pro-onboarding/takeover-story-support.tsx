/**
 * Shared setup for the provisioning-takeover playground: everything that stands
 * in for what `BillingOnboardingModal` supplies and Storybook cannot.
 *
 * That is the plan catalog read, answered from a story-local query cache; the
 * takeover frame the modal draws around the step; the props it passes on
 * every mount; and the fixture tables the Controls panel selects a row from
 * (the plan move, the captured reconcile failure).
 *
 * The catalog fixture mirrors the platform's real Pro catalog (Mighty on
 * `credits_25`, Super on `credits_45`), so the credits chip quotes the amounts a
 * subscriber is actually billed, and each scenario's dimensions are the ones its
 * packages really carry.
 *
 * Not a `.stories.tsx` file, so Storybook does not index it.
 */
import type { Decorator } from "@storybook/react-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";

import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTier,
  MachineSizeEnum,
  PlanListResponse,
} from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { createStoryQueryClient } from "@/lib/story-query-cache";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import type { ProvisioningDimensions } from "./provisioning-machine";
import {
  PROVISIONING_SURFACE,
  type ProvisioningStateProps,
} from "./provisioning-state";
import type { TakeoverDirection } from "./takeover-copy";
import type { CreditTierChange } from "./use-provisioning-credits";

// The takeover's stream draws bundled characters, and the bundled-component
// chunk is a dynamic import. Warming it at module scope keeps the first frame
// from holding an empty stage, the way `plans-page.tsx` does.
preloadBundledAvatarComponents();

const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

/**
 * The credit bundles the packages above are built on. `label` is the bundle's
 * customer-facing usage name, the same wording the package carries in
 * `usage_label`: the credits chip renders it verbatim, so a dollar-denominated
 * label would leak an amount the chip must never name.
 */
function creditTier(
  tier: string,
  label: string,
  creditsUsd: number,
  legacy: boolean,
): CreditTier {
  return {
    tier,
    label,
    credits_usd: creditsUsd,
    price_cents: creditsUsd * 100,
    lookup_key: `vellum_credits_${creditsUsd}`,
    legacy,
  };
}

/**
 * One catalog for every story. `machine_tiers` and `storage_tiers` are empty
 * because the takeover reads only `credit_tiers` (to price and name the credits
 * chip) and `packages` (to resolve a package intent's bundle).
 *
 * `credits_45` and `credits_115` are the packages' own bundles, which the
 * platform does not offer in the picker, so they carry the `legacy` marking the
 * catalog gives a tier that is current-but-not-offered.
 */
const STORY_PLANS: PlanListResponse = {
  plans: [
    {
      id: "pro",
      name: "Pro",
      base_lookup_key: "vellum_pro_base",
      base_price_cents: 1000,
      billing_interval: "month",
      included_features: [],
      machine_tiers: [],
      storage_tiers: [],
      credit_tiers: [
        creditTier("credits_25", "Mighty Usage", 25, false),
        creditTier("credits_45", "Super Usage", 45, true),
        creditTier("credits_115", "Ultra Usage", 115, true),
      ],
      packages: [MIGHTY, SUPER, ULTRA],
    },
  ],
};

/** One client for every story, holding the plan catalog the credits row reads. */
const queryClient = createStoryQueryClient();

queryClient.setQueryData(
  organizationsBillingPlansRetrieveQueryKey(),
  STORY_PLANS,
);

/** A constant stamp, so a story's props never change between renders. */
const INTENT_SAVED_AT = 0;

/** A checkout that bought the Mighty package. */
const PACKAGE_INTENT: CheckoutIntent = {
  kind: "package",
  packageKey: MIGHTY.key,
  savedAt: INTENT_SAVED_AT,
};

/** A custom checkout that picked a machine and storage but no bundle. */
const CUSTOM_INTENT_TWO_ITEMS: CheckoutIntent = {
  kind: "custom",
  machineTier: "large",
  storageTier: "xl",
  creditTier: null,
  savedAt: INTENT_SAVED_AT,
};

/** A custom checkout that picked all three, which widens the chip row. */
const CUSTOM_INTENT_THREE_ITEMS: CheckoutIntent = {
  kind: "custom",
  machineTier: "medium",
  storageTier: "s",
  creditTier: "credits_45",
  savedAt: INTENT_SAVED_AT,
};

/** Nothing to provision on a dimension, and nothing read on it either. */
const NOTHING_TO_PROVISION: ProvisioningDimensions = {
  machineSize: null,
  storageGib: null,
};

/**
 * A base-plan assistant: the standard machine on the smallest volume. A Mighty
 * subscriber sits here too, since that package adds no machine or storage.
 */
const BASE_ACTUALS: ProvisioningDimensions = {
  machineSize: "small",
  storageGib: 10,
};

/** What Mighty settles at: no machine tier of its own, 10 GB. */
const MIGHTY_TARGETS: ProvisioningDimensions = {
  machineSize: null,
  storageGib: 10,
};

/** What Super buys: the medium machine on 30 GB. */
const SUPER_TARGETS: ProvisioningDimensions = {
  machineSize: "medium",
  storageGib: 30,
};

/** What Ultra buys, and the plateau a credit-only switch sits on. */
const ULTRA_TARGETS: ProvisioningDimensions = {
  machineSize: "large",
  storageGib: 60,
};

/**
 * One plan move the takeover can be watching, as the props that describe it.
 * Checkout mode carries a stashed `intent` and reads its bundle from there; an
 * in-place resize carries `creditsChange` instead, so a stale stash can't leak
 * into it. No scenario carries both.
 */
export interface TakeoverScenario {
  /** Purchased ceilings, the "to" side of the machine and storage chips. */
  targets: ProvisioningDimensions;
  /** Pre-change actuals, the "from" side of every dimension chip. */
  fromSnapshot: ProvisioningDimensions;
  /** Display-only settle size for a package that names no machine tier. */
  machineFloor?: MachineSizeEnum | null;
  /** The checkout selection stashed before the Stripe redirect. */
  intent: CheckoutIntent | null;
  /** The bundle move an in-place resize carries instead of a stash. */
  creditsChange?: CreditTierChange | null;
  /** Which way the move goes, which selects the phase copy. */
  direction: TakeoverDirection;
}

/**
 * The plan moves the `change` control picks between, each named for the move it
 * describes rather than the chips it happens to draw.
 */
export const TAKEOVER_SCENARIOS = {
  /** Base to Super: both dimensions grow and the bundle arrives. Three chips. */
  baseToSuper: {
    targets: SUPER_TARGETS,
    fromSnapshot: BASE_ACTUALS,
    intent: null,
    creditsChange: { fromTier: null, toTier: "credits_45" },
    direction: "upgrade",
  },
  /**
   * Base to Mighty. Mighty runs on the standard machine at the smallest volume,
   * so the pod stays exactly where it is and the bundle is the whole move.
   */
  baseToMighty: {
    targets: MIGHTY_TARGETS,
    fromSnapshot: BASE_ACTUALS,
    machineFloor: "small",
    intent: null,
    creditsChange: { fromTier: null, toTier: "credits_25" },
    direction: "upgrade",
  },
  /** Mighty to Super as an in-place resize: every dimension steps up. */
  mightyToSuper: {
    targets: SUPER_TARGETS,
    fromSnapshot: BASE_ACTUALS,
    intent: null,
    creditsChange: { fromTier: "credits_25", toTier: "credits_45" },
    direction: "upgrade",
  },
  /**
   * Super down to Mighty. Mighty names no machine tier, so the display-only
   * `machineFloor` supplies the size the server settles the pod at. Storage
   * never shrinks, so the lowered volume gets no chip at all.
   */
  superToMighty: {
    targets: MIGHTY_TARGETS,
    fromSnapshot: SUPER_TARGETS,
    machineFloor: "small",
    intent: null,
    creditsChange: { fromTier: "credits_45", toTier: "credits_25" },
    direction: "downgrade",
  },
  /**
   * More storage on the same machine and bundle. The machine target is null, so
   * no machine chip is drawn: a row for a pod that stays exactly where it is
   * would assert a resize that never runs.
   */
  storageOnly: {
    targets: { machineSize: null, storageGib: 60 },
    fromSnapshot: BASE_ACTUALS,
    intent: null,
    direction: "change",
  },
  /**
   * A credit-only switch: the machine and the volume both stay put, so the
   * credit move is the takeover's one statement of what changed.
   */
  creditOnlySwitch: {
    targets: ULTRA_TARGETS,
    fromSnapshot: ULTRA_TARGETS,
    intent: null,
    creditsChange: { fromTier: "credits_25", toTier: "credits_115" },
    direction: "change",
  },
  /** Dropping the bundle entirely: the to-side is the explicit no-credits choice. */
  bundleDropped: {
    targets: ULTRA_TARGETS,
    fromSnapshot: ULTRA_TARGETS,
    intent: null,
    creditsChange: { fromTier: "credits_115", toTier: null },
    direction: "change",
  },
  /**
   * A freshly hatched assistant, whose actuals have never been read. Both chips
   * drop their from-side and state only where they are headed.
   */
  freshHatch: {
    targets: SUPER_TARGETS,
    fromSnapshot: NOTHING_TO_PROVISION,
    intent: null,
    direction: "upgrade",
  },
  /** A custom checkout of a machine and storage, with no bundle picked. */
  customTwoItems: {
    targets: { machineSize: "large", storageGib: 250 },
    fromSnapshot: BASE_ACTUALS,
    intent: CUSTOM_INTENT_TWO_ITEMS,
    direction: "upgrade",
  },
  /** A custom checkout with all three items picked, which widens the chip row. */
  customThreeItems: {
    targets: SUPER_TARGETS,
    fromSnapshot: BASE_ACTUALS,
    intent: CUSTOM_INTENT_THREE_ITEMS,
    direction: "upgrade",
  },
  /** A package checkout, whose confirm phase names the package it bought. */
  packageIntent: {
    targets: MIGHTY_TARGETS,
    fromSnapshot: BASE_ACTUALS,
    machineFloor: "small",
    intent: PACKAGE_INTENT,
    direction: "upgrade",
  },
} satisfies Record<string, TakeoverScenario>;

export type TakeoverScenarioKey = keyof typeof TAKEOVER_SCENARIOS;

/**
 * The ensure-provisioned failures the `snag` control picks between. `none` is
 * the wait that simply ran long, which STALLED words honestly instead of
 * escalating; everything else is a real captured failure, and the caption comes
 * from `extractOnboardingErrorMessage` reading whichever field carries a
 * message.
 */
export const TAKEOVER_SNAGS = {
  /** No captured failure, so the wait is just slow. */
  none: undefined,
  /** A mapped code: the reconcile could not queue the change. */
  submissionFailed: { error: "provisioning_submission_failed" },
  /** A mapped code: the reconcile could not see the Pro entitlement yet. */
  noActivePro: { error: "no_active_pro" },
  /** No mapped code, so the server's own `detail` carries the caption. */
  rawDetail: { detail: "Resize already in progress." },
  /** A failure with nothing readable in it, so the direction words the caption. */
  network: {},
} satisfies Record<string, unknown>;

export type TakeoverSnagKey = keyof typeof TAKEOVER_SNAGS;

/** Long enough that a terminal phase stays on screen for as long as it is open. */
const STORY_DWELL_MS = 60 * 60 * 1000;

/**
 * The props every scenario shares. `phaseMinMs: 0` disables the per-phase hold
 * so the requested phase paints immediately instead of waiting out the floor the
 * app uses to keep a fast upgrade from flashing.
 */
export const TAKEOVER_CONSTANT_PROPS = {
  celebrating: true,
  dwellMs: STORY_DWELL_MS,
  onCelebrationEnd: () => {},
  onEscape: () => {},
  confirm: { onRetry: () => {}, onGoToBilling: () => {} },
  phaseMinMs: 0,
} satisfies Partial<ProvisioningStateProps>;

/** The cache the takeover's plan-catalog read resolves from. */
export const takeoverQueryDecorator: Decorator = (Story) => (
  <QueryClientProvider client={queryClient}>
    <Story />
  </QueryClientProvider>
);

/**
 * The takeover frame: a viewport-tall box on the takeover's own ground, which
 * `BillingOnboardingModal` puts on its own content box.
 *
 * Reproduced in flow rather than mounted through `Modal.Content`, whose overlay
 * is `fixed`: one portaled overlay per story would stack every story in a file
 * on top of the others in the shared docs iframe.
 */
export const takeoverFrameDecorator: Decorator =
  function TakeoverFrameDecorator(Story) {
    return (
      <TakeoverFrame>
        <Story />
      </TakeoverFrame>
    );
  };

/** The frame itself, for a story that mounts the takeover in its own render. */
function TakeoverFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-theme="light"
      className="flex h-screen w-full flex-col overflow-y-auto"
      style={{ backgroundColor: PROVISIONING_SURFACE }}
    >
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * Both decorators as one component, for a story outside this folder that
 * plays the takeover as a step of a longer flow: the query cache its read
 * resolves from, and the frame the modal draws around it.
 */
export function TakeoverStage({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TakeoverFrame>{children}</TakeoverFrame>
    </QueryClientProvider>
  );
}
