/**
 * Shared setup for the two provisioning-takeover story files, which document
 * the same component with the `obscure-credits` flag off and on.
 *
 * Everything here stands in for what `BillingOnboardingModal` supplies and
 * Storybook cannot: the plan catalog and the avatar reads, answered from a
 * story-local query cache, plus the takeover frame the modal draws around the
 * step and the props it passes on every mount.
 *
 * Not a `.stories.tsx` file, so Storybook does not index it.
 */
import type { Decorator } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CSSProperties } from "react";

import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";
import { organizationsBillingPlansRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { CreditTier, PlanListResponse } from "@/generated/api/types.gen";
import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import type { ProvisioningDimensions } from "./provisioning-machine";
import {
  TAKEOVER_SURFACE_VAR,
  type ProvisioningStateProps,
} from "./provisioning-state";
import { useTakeoverSurface } from "./use-takeover-surface";

// The takeover draws the assistant creature at 240px, and the bundled-component
// chunk is a dynamic import. Warming it at module scope keeps the first frame
// from holding an empty stage, the way `plans-page.tsx` does.
preloadBundledAvatarComponents();

/** The assistant whose avatar is a bundled creature: a purple blob. */
export const CREATURE_ASSISTANT_ID = "story-assistant-creature";
/** The assistant whose avatar is an uploaded image, blurred behind the content. */
export const PHOTO_ASSISTANT_ID = "story-assistant-photo";
/** An assistant with nothing in the avatar cache, so the read has to settle. */
export const UNRESOLVED_ASSISTANT_ID = "story-assistant-unresolved";

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

/** A constant stamp, so a story's props never change between renders. */
const INTENT_SAVED_AT = 0;

/** A checkout that bought the Mighty package. */
export const PACKAGE_INTENT: CheckoutIntent = {
  kind: "package",
  packageKey: MIGHTY.key,
  savedAt: INTENT_SAVED_AT,
};

/** A custom checkout that picked a machine and storage but no bundle. */
export const CUSTOM_INTENT_TWO_ITEMS: CheckoutIntent = {
  kind: "custom",
  machineTier: "large",
  storageTier: "xl",
  creditTier: null,
  savedAt: INTENT_SAVED_AT,
};

/** A custom checkout that picked all three, which widens the chip row. */
export const CUSTOM_INTENT_THREE_ITEMS: CheckoutIntent = {
  kind: "custom",
  machineTier: "medium",
  storageTier: "s",
  creditTier: "credits_45",
  savedAt: INTENT_SAVED_AT,
};

export const NOTHING_TO_PROVISION: ProvisioningDimensions = {
  machineSize: null,
  storageGib: null,
};

/**
 * Everything but the phase, which each meta names for itself. `phaseMinMs={0}`
 * disables the per-phase hold so the requested `state` paints immediately
 * instead of waiting out the floor the app uses to keep a fast upgrade from
 * flashing.
 */
export const TAKEOVER_BASE_ARGS: Omit<ProvisioningStateProps, "state"> = {
  softWaiting: false,
  intent: null,
  targets: NOTHING_TO_PROVISION,
  fromSnapshot: NOTHING_TO_PROVISION,
  celebrating: false,
  onCelebrationEnd: () => {},
  assistantId: CREATURE_ASSISTANT_ID,
  escapeAvailable: false,
  onEscape: () => {},
  confirm: { onRetry: () => {}, onGoToBilling: () => {} },
  phaseMinMs: 0,
};

/** The cache the takeover's plan-catalog and avatar reads resolve from. */
export const takeoverQueryDecorator: Decorator = (Story) => (
  <QueryClientProvider client={queryClient}>
    <Story />
  </QueryClientProvider>
);

/**
 * The takeover frame: a black ground, a viewport-tall box, `data-theme="dark"`,
 * and the `--takeover-surface` custom property, all of which
 * `BillingOnboardingModal` puts on its own content box.
 *
 * Reproduced in flow rather than mounted through `Modal.Content`, whose overlay
 * is `fixed`: one portaled overlay per story would stack every story in a file
 * on top of the others in the shared docs iframe.
 */
export const takeoverFrameDecorator: Decorator<ProvisioningStateProps> =
  function TakeoverFrame(Story, context) {
    const { tintHex } = useTakeoverSurface(context.args.assistantId);
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
