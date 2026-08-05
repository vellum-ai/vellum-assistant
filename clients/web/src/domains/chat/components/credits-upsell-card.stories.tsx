/**
 * The credit wall: the surface that answers "when do we show **Add credits**
 * and when do we show **Upgrade**?".
 *
 * These stories drive the real {@link CreditsUpsellCard}, not a lookalike, so
 * the branch under test is the production one at `credits-upsell-card.tsx:51`:
 *
 *   isUpgrade = isBillingCtaUpgradeArm(arm) && isFreePlan === true
 *
 * Both inputs are seeded through their real read seams: the
 * `experiment-billing-cta-2026-07-23` arm via the client feature-flag store,
 * and `plan_id` via the subscription query cache. If either seam moves,
 * these stories move with it instead of silently drifting.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { CreditsUpsellCard } from "@/domains/chat/components/credits-upsell-card";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanIdEnum,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/** The `experiment-billing-cta-2026-07-23` arm, keyed as the store holds it. */
const ARM_FLAG_KEY = "experimentBillingCta20260723";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

function makeSubscription(planId: PlanIdEnum): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

interface CreditWallStoryArgs {
  /** `experiment-billing-cta-2026-07-23` arm. */
  arm: "control" | "upgrade-cta";
  /** `plan_id` on the billing subscription. `base` is the free plan. */
  planId: "base" | "pro";
  /** Whether a platform session exists; `absent` drives the login treatment. */
  platformSession: "present" | "absent";
  /** A self-hosted active assistant gates the card away entirely. */
  selfHosted: boolean;
}

/**
 * Seeds the four real read seams the card seldom sees in one place, then hands
 * every one of them back on unmount so a story cannot leak its billing state
 * into the next one. Written in an effect rather than during render because
 * these stores are subscribed by the tree being rendered.
 */
function SeededStores({
  args,
  children,
}: {
  args: CreditWallStoryArgs;
  children: React.ReactNode;
}) {
  const { arm, planId, platformSession, selfHosted } = args;

  useLayoutEffect(() => {
    const previousAuth = useAuthStore.getState().platformSession;
    const previousLifecycle =
      useAssistantLifecycleStore.getState().assistantState;

    useAuthStore.setState({ platformSession });
    useAssistantLifecycleStore.setState({
      assistantState: selfHosted
        ? { kind: "self_hosted" }
        : { kind: "active", isLocal: false, health: "healthy" },
    });
    // `setStringFlag` is the store's own override seam (the same one the
    // localStorage dev override uses), so the arm is set exactly the way a
    // real client sets it rather than by reaching past the store's types.
    useClientFeatureFlagStore.getState().setStringFlag(ARM_FLAG_KEY, arm);
    // `useIsFreePlan` reads the subscription through TanStack Query, which
    // serves cached data even while `enabled` is false, so seeding the cache
    // is enough and no org-store hydration is needed.
    queryClient.setQueryData(
      organizationsBillingSubscriptionRetrieveOptions().queryKey,
      makeSubscription(planId),
    );

    return () => {
      useAuthStore.setState({ platformSession: previousAuth });
      useAssistantLifecycleStore.setState({
        assistantState: previousLifecycle,
      });
      useClientFeatureFlagStore.getState().clearStringOverride(ARM_FLAG_KEY);
      queryClient.removeQueries({
        queryKey: organizationsBillingSubscriptionRetrieveOptions().queryKey,
      });
    };
  }, [arm, planId, platformSession, selfHosted]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const meta: Meta<CreditWallStoryArgs> = {
  title: "Upsell Walls/Credit Wall",
  // Opted out of the global `autodocs` tag. The card resolves its CTA from
  // module-singleton Zustand stores, so N variants cannot co-exist: the docs
  // page mounts every story at once and whichever effect ran last decides the
  // arm, plan and gate for all of them. In practice the last story here is the
  // self-hosted one, which gated every card to `null` and rendered the page as
  // five empty boxes. Isolating the seed per instance is not possible while the
  // source of truth is a module singleton, so the variants are canvas-only,
  // where exactly one is mounted at a time. `Upsell Walls/Overview` carries the
  // side-by-side comparison instead, built on the presentational primitive fed
  // with this card's real exported copy.
  tags: ["!autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    arm: { control: "radio", options: ["control", "upgrade-cta"] },
    planId: { control: "radio", options: ["base", "pro"] },
    platformSession: { control: "radio", options: ["present", "absent"] },
    selfHosted: { control: "boolean" },
  },
  args: {
    arm: "control",
    planId: "base",
    platformSession: "present",
    selfHosted: false,
  },
  render: (args) => (
    <SeededStores args={args}>
      {/* The card is detached and sizes itself against the composer width. */}
      <div className="mx-auto w-full max-w-[720px]">
        <CreditsUpsellCard />
      </div>
    </SeededStores>
  ),
};

export default meta;
type Story = StoryObj<CreditWallStoryArgs>;

/**
 * **Add credits**: the default everyone gets. The control arm never shows an
 * upgrade CTA, so a free-plan org still lands here.
 */
export const AddCredits_ControlArm: Story = {
  name: "Add credits · control arm (default)",
  args: { arm: "control", planId: "base" },
};

/**
 * **Upgrade**: the only combination that swaps the CTA. It needs the `upgrade-cta` arm
 * *and* a free (`base`) plan. Note the title also changes to "out of **Free**
 * credits". The CTA routes to the plans takeover rather than opening the Add
 * Credits modal.
 */
export const Upgrade_FreePlanInUpgradeArm: Story = {
  name: "View plans · upgrade arm + free plan",
  args: { arm: "upgrade-cta", planId: "base" },
};

/**
 * A paying org in the upgrade arm keeps **Add credits**, because the experiment only
 * ever re-points free users. This is the story that proves the swap is not
 * simply "the flag is on".
 */
export const AddCredits_PaidPlanInUpgradeArm: Story = {
  name: "Add credits · upgrade arm + paid plan",
  args: { arm: "upgrade-cta", planId: "pro" },
};

/**
 * Platform reachable but no session: every billing CTA would dead-end, so the
 * card swaps itself for the shared login affordance.
 */
export const NoPlatformSession: Story = {
  name: "Log in · no platform session",
  args: { platformSession: "absent" },
};

/**
 * A self-hosted active assistant gates the card away entirely. It renders
 * `null`, which is why this story is deliberately empty.
 */
export const SelfHostedRendersNothing: Story = {
  name: "Gated · self-hosted (renders nothing)",
  args: { selfHosted: true },
};
