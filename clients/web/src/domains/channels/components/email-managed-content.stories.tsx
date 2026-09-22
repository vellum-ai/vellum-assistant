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
import { QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";

import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";
import { organizationsBillingSubscriptionRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { createStoryQueryClient } from "@/lib/story-query-cache";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { LS_ASSISTANT_INBOX_HIDDEN } from "@/utils/local-settings-keys";

const queryClient = createStoryQueryClient();

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

const STORY_ASSISTANT_ID = "story-assistant";

/**
 * The same wall with the `assistant-inbox` flag on: the body of the Assistant
 * Inbox's pitch, set at the start with a plain perk list and no card of its
 * own, since the Email section around it is the card and its header carries
 * the pitch's title (that swap lives in `EmailChannelSection`, so it is not
 * drawn here). The rail entry is seeded as dismissed, which is what brings up
 * the "Add it back" line under the actions; press it and the line goes.
 */
export const NotEntitledInboxFlagOn: Story = {
  name: "Not entitled · Assistant Inbox flag on",
  beforeEach: () => {
    useClientFeatureFlagStore.setState({ assistantInbox: true });
    useResolvedAssistantsStore.setState({
      activeAssistantId: STORY_ASSISTANT_ID,
    });
    localStorage.setItem(LS_ASSISTANT_INBOX_HIDDEN, "1");
    // Both spellings of the key: the avatar hook appends a manifest-support
    // flag the story cannot predict.
    for (const supportsManifest of [true, false]) {
      queryClient.setQueryData(
        [...avatarQueryKey(STORY_ASSISTANT_ID), supportsManifest],
        {
          components: BUNDLED_COMPONENTS,
          traits: { bodyShape: "blob", eyeStyle: "curious", color: "purple" },
          customImageUrl: null,
        },
      );
    }
    return () => {
      useClientFeatureFlagStore.setState({ assistantInbox: false });
      localStorage.removeItem(LS_ASSISTANT_INBOX_HIDDEN);
    };
  },
};
