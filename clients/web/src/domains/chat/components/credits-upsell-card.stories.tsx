/**
 * The credit wall: the surface that answers "when do we show **Add credits**
 * and when do we show **Upgrade**?".
 *
 * These stories drive the real {@link CreditsUpsellCard}, not a lookalike, so
 * the branch under test is the production one at `credits-upsell-card.tsx:48`:
 *
 *   isUpgrade = isFreePlan === true
 *
 * `plan_id` is seeded through its real read seam, the subscription query
 * cache. If that seam moves, these stories move with it instead of silently
 * drifting.
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

function makeSubscription(planId: PlanIdEnum): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

interface CreditWallStoryArgs {
  /** `plan_id` on the billing subscription. `base` is the free plan. */
  planId: "base" | "pro";
  /** Whether a platform session exists; `absent` drives the login treatment. */
  platformSession: "present" | "absent";
  /** A self-hosted active assistant gates the card away entirely. */
  selfHosted: boolean;
}

/**
 * Seeds the three real read seams the card seldom sees in one place, then hands
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
  const { planId, platformSession, selfHosted } = args;

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
      queryClient.removeQueries({
        queryKey: organizationsBillingSubscriptionRetrieveOptions().queryKey,
      });
    };
  }, [planId, platformSession, selfHosted]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const meta: Meta<CreditWallStoryArgs> = {
  title: "Upsell Walls/Credit Wall",
  // Opted out of the global `autodocs` tag. The card resolves its CTA from
  // module-singleton Zustand stores and one shared query cache, so N variants
  // cannot co-exist: the docs page mounts every story at once and whichever
  // effect ran last decides the plan and gate for all of them. In practice the
  // last story here is the self-hosted one, which gated every card to `null`
  // and rendered the page as four empty boxes. Isolating the seed per instance
  // is not possible while the source of truth is a module singleton, so the
  // variants are canvas-only, where exactly one is mounted at a time.
  // `Upsell Walls/Overview` carries the side-by-side comparison instead, built
  // on the presentational primitive fed with this card's real exported copy.
  tags: ["!autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    planId: { control: "radio", options: ["base", "pro"] },
    platformSession: { control: "radio", options: ["present", "absent"] },
    selfHosted: { control: "boolean" },
  },
  args: {
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
 * **Upgrade**: a free (`base`) plan is the only thing that swaps the CTA. Note
 * the title also changes to "out of **Free** credits". The CTA routes to the
 * plans takeover rather than opening the Add Credits modal.
 */
export const Upgrade_FreePlan: Story = {
  name: "View plans · free plan",
  args: { planId: "base" },
};

/**
 * **Add credits**: what a paying org gets, because the wall only ever
 * re-points free users. An unresolved plan lands here too.
 */
export const AddCredits_PaidPlan: Story = {
  name: "Add credits · paid plan",
  args: { planId: "pro" },
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
