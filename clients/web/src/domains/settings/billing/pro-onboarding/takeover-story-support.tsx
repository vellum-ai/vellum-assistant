/**
 * Shared setup for the provisioning-takeover playground: everything that stands
 * in for what `BillingOnboardingModal` supplies and Storybook cannot.
 *
 * That is the plan catalog and the avatar reads, answered from a story-local
 * query cache; the takeover frame the modal draws around the step; the props it
 * passes on every mount; and the fixture tables the Controls panel selects a row
 * from (the plan move, the captured reconcile failure, the seeded assistant).
 *
 * The catalog fixture mirrors the platform's real Pro catalog (Mighty on
 * `credits_25`, Super on `credits_45`), so the credits chip quotes the amounts a
 * subscriber is actually billed, and each scenario's dimensions are the ones its
 * packages really carry.
 *
 * Not a `.stories.tsx` file, so Storybook does not index it.
 */
import type { Decorator } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, type CSSProperties } from "react";

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
import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import type { ProvisioningDimensions } from "./provisioning-machine";
import {
  TAKEOVER_SURFACE_VAR,
  type ProvisioningStateProps,
} from "./provisioning-state";
import type { TakeoverDirection } from "./takeover-copy";
import type { CreditTierChange } from "./use-provisioning-credits";
import { useTakeoverSurface } from "./use-takeover-surface";

// The takeover draws the assistant creature at 240px, and the bundled-component
// chunk is a dynamic import. Warming it at module scope keeps the first frame
// from holding an empty stage, the way `plans-page.tsx` does.
preloadBundledAvatarComponents();

/** The assistant whose avatar is a bundled creature: a purple blob. */
const CREATURE_ASSISTANT_ID = "story-assistant-creature";
/** The assistant whose avatar is an uploaded image, blurred behind the content. */
const PHOTO_ASSISTANT_ID = "story-assistant-photo";
/** An assistant with nothing in the avatar cache, so the read has to settle. */
const UNRESOLVED_ASSISTANT_ID = "story-assistant-unresolved";

const CREATURE_TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "purple",
};

/**
 * A stand-in for an uploaded avatar. Inline so nothing is fetched from a host
 * Storybook may not reach; the hexes are fixture data the component receives,
 * not story styling.
 */
const PHOTO_AVATAR_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMjQwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjI0MCIgZmlsbD0iIzJGNkY0RiIvPjxjaXJjbGUgY3g9IjEyMCIgY3k9IjEwNCIgcj0iNTgiIGZpbGw9IiNFOUM5MUEiLz48cmVjdCB4PSI0NiIgeT0iMTY4IiB3aWR0aD0iMTQ4IiBoZWlnaHQ9IjQ0IiByeD0iMjIiIGZpbGw9IiMwRTlCOEIiLz48L3N2Zz4=";

const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

/**
 * The credit bundles the packages above are built on. `label` is the bundle's
 * customer-facing usage name, the same wording the package carries in
 * `usage_label`: the `obscure-credits` chip renders it verbatim in place of a
 * monthly rate, so a dollar-denominated label would defeat the flag.
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

/**
 * One client for every story: distinct assistant ids let a single cache serve
 * the creature, the uploaded image, and the assistant nothing was seeded for.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

queryClient.setQueryData(
  organizationsBillingPlansRetrieveQueryKey(),
  STORY_PLANS,
);

// `useAssistantAvatar` keys on the per-assistant manifest gate, which resolves
// from the assistant's version and is unknowable here. Seeding both values
// renders the avatar whichever way the gate lands.
function seedAvatar(assistantId: string, avatar: AvatarData): void {
  for (const supportsManifest of [false, true]) {
    queryClient.setQueryData(
      [...avatarQueryKey(assistantId), supportsManifest],
      avatar,
    );
  }
}

seedAvatar(CREATURE_ASSISTANT_ID, {
  components: BUNDLED_COMPONENTS,
  traits: CREATURE_TRAITS,
  customImageUrl: null,
});
seedAvatar(PHOTO_ASSISTANT_ID, {
  components: BUNDLED_COMPONENTS,
  traits: null,
  customImageUrl: PHOTO_AVATAR_URL,
});

/** The assistants the `avatar` control picks between, by their seeded id. */
export const TAKEOVER_AVATARS = {
  creature: CREATURE_ASSISTANT_ID,
  photo: PHOTO_ASSISTANT_ID,
  unresolved: UNRESOLVED_ASSISTANT_ID,
} satisfies Record<string, string>;

export type TakeoverAvatarKey = keyof typeof TAKEOVER_AVATARS;

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

/** The cache the takeover's plan-catalog and avatar reads resolve from. */
export const takeoverQueryDecorator: Decorator = (Story) => (
  <QueryClientProvider client={queryClient}>
    <Story />
  </QueryClientProvider>
);

/**
 * Puts the `obscure-credits` flag where the `obscureCredits` control says, so
 * the flag-on treatment is one toggle away rather than its own story file.
 *
 * Written straight into the store rather than through `setFlags`, which layers
 * local and env overrides back on top (an override to `false` would win) and
 * marks the store hydrated as if a server response had landed. The write sits in
 * an effect because the tree below subscribes to this store, and the whole
 * previous state is handed back on unmount so nothing set here outlives the
 * story.
 */
export const obscureCreditsDecorator: Decorator<{ obscureCredits: boolean }> =
  function ObscureCreditsFlag(Story, context) {
    const { obscureCredits } = context.args;
    useLayoutEffect(() => {
      const previous = useClientFeatureFlagStore.getState();
      useClientFeatureFlagStore.setState({ obscureCredits });
      return () => {
        useClientFeatureFlagStore.setState(previous, true);
      };
    }, [obscureCredits]);
    return <Story />;
  };

/**
 * The takeover frame: a black ground, a viewport-tall box, `data-theme="dark"`,
 * and the `--takeover-surface` custom property, all of which
 * `BillingOnboardingModal` puts on its own content box.
 *
 * Reproduced in flow rather than mounted through `Modal.Content`, whose overlay
 * is `fixed`: one portaled overlay per story would stack every story in a file
 * on top of the others in the shared docs iframe.
 */
export const takeoverFrameDecorator: Decorator<{ avatar: TakeoverAvatarKey }> =
  function TakeoverFrame(Story, context) {
    const { tintHex } = useTakeoverSurface(
      TAKEOVER_AVATARS[context.args.avatar],
    );
    return (
      <div
        data-theme="dark"
        className="flex h-screen w-full flex-col overflow-y-auto bg-black"
        style={{ [TAKEOVER_SURFACE_VAR]: tintHex } as CSSProperties}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <Story />
        </div>
      </div>
    );
  };
