/**
 * The managed-email entitlement wall: the only true *entitlement* gate in the
 * web client. Everything else that upsells is a resource wall (credits,
 * storage) or plan management.
 *
 * The gate reads `entitlements.managed_email` off the billing subscription
 * rather than the plan id (`email-managed-content.tsx:86-91`), because an admin
 * override can grant a Base org the entitlement. It is deliberately tri-state:
 * entitled / explicitly-not-entitled / unknown, and only the middle one shows
 * the wall. An unknown subscription fails open to the form.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";

import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const NOT_ENTITLED: SubscriptionResponse = {
  plan_id: "base",
  status: "active",
  renewal_date: null,
  current_period_start: null,
  current_period_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
  entitlements: { managed_email: false, phone_number: false },
};

const meta: Meta<typeof EmailManagedContent> = {
  title: "Upsell Walls/Managed Email Entitlement",
  component: EmailManagedContent,
  parameters: { layout: "padded" },
  args: {
    assistantId: "story-assistant",
    assistantHandle: "ada",
    emailRootDomain: "vellum.ai",
  },
  decorators: [
    (Story) => {
      useLayoutEffect(() => {
        queryClient.setQueryData(
          organizationsBillingSubscriptionRetrieveOptions().queryKey,
          NOT_ENTITLED,
        );
        return () => {
          queryClient.removeQueries({
            queryKey:
              organizationsBillingSubscriptionRetrieveOptions().queryKey,
          });
        };
      }, []);
      return (
        <QueryClientProvider client={queryClient}>
          <div className="mx-auto w-full max-w-[720px]">
            <Story />
          </div>
        </QueryClientProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof EmailManagedContent>;

/**
 * The wall: an info-tone notice with a single **Upgrade** CTA into the plans
 * takeover. The form behind it is never rendered, because the downstream domain
 * queries are gated off the same entitlement, so a non-entitled org never
 * fires a request that would 403.
 */
export const NotEntitled: Story = {
  name: "Not entitled · Upgrade",
};
