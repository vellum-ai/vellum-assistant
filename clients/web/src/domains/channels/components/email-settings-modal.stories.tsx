/**
 * The email settings modal the Assistant Inbox opens from its masthead's
 * gear: the managed address in a read-only field with its copy and remove
 * controls, the domain's verification on the label line, the day's usage,
 * and who can message the assistant over email.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { EmailSettingsModal } from "@/domains/channels/components/email-settings-modal";
import {
  assistantsDomainsListOptions,
  assistantsDomainsVerificationStatusRetrieveOptions,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesStatusRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { assistantChannelAdmissionPolicyListQueryKey } from "@/generated/gateway/@tanstack/react-query.gen";
import { withQueryCache } from "@/lib/story-query-cache";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "story-assistant";
const LOCAL_ASSISTANT_ID = "local-story-assistant";
const DOMAIN_ID = "domain-1";
const ADDRESS_ID = "address-1";
const SUBDOMAIN = "velly";
const ROOT_DOMAIN = "vellum.me";
const ADDRESS = `hi@${SUBDOMAIN}.${ROOT_DOMAIN}`;

/** Gateways from this version on serve the trust-floor routes. */
const TRUST_FLOORS_VERSION = "0.10.0";

const withEmailQueryCache = withQueryCache((client) => {
  const path = { assistant_id: ASSISTANT_ID };
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveOptions().queryKey,
    {
      plan_id: "pro",
      status: "active",
      renewal_date: null,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      entitlements: { managed_email: true, phone_number: false },
    },
  );
  client.setQueryData(assistantsDomainsListOptions({ path }).queryKey, {
    count: 1,
    next: null,
    previous: null,
    results: [
      {
        id: DOMAIN_ID,
        subdomain: SUBDOMAIN,
        created: "2026-09-01T00:00:00Z",
        modified: "2026-09-01T00:00:00Z",
      },
    ],
  });
  client.setQueryData(assistantsEmailAddressesListOptions({ path }).queryKey, {
    count: 1,
    next: null,
    previous: null,
    results: [
      { id: ADDRESS_ID, address: ADDRESS, created_at: "2026-09-01T00:00:00Z" },
    ],
  });
  client.setQueryData(
    assistantsDomainsVerificationStatusRetrieveOptions({
      path: { ...path, id: DOMAIN_ID },
    }).queryKey,
    { domain: `${SUBDOMAIN}.${ROOT_DOMAIN}`, status: "verified", message: "" },
  );
  client.setQueryData(
    assistantsEmailAddressesStatusRetrieveOptions({
      path: { ...path, id: ADDRESS_ID },
    }).queryKey,
    {
      address: ADDRESS,
      status: "active",
      usage: {
        sent_today: 3,
        daily_limit: 100,
        received_today: 5,
        sent_this_month: 41,
        received_this_month: 67,
      },
      created_at: "2026-09-01T00:00:00Z",
    },
  );
  client.setQueryData(
    assistantChannelAdmissionPolicyListQueryKey({
      path: { assistant_id: LOCAL_ASSISTANT_ID },
    }),
    {
      policies: [
        {
          channelType: "email",
          policy: "trusted_contacts",
          note: null,
          updatedAt: null,
        },
      ],
    },
  );
});

const meta: Meta<typeof EmailSettingsModal> = {
  title: "Channels/EmailSettingsModal",
  component: EmailSettingsModal,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn().mockName("onOpenChange"),
    assistantId: ASSISTANT_ID,
    localAssistantId: LOCAL_ASSISTANT_ID,
    assistantName: "Velly",
    assistantHandle: SUBDOMAIN,
    emailRootDomain: ROOT_DOMAIN,
  },
  beforeEach: () => {
    // The body reads the active assistant off the store, and the trust-floor
    // section only renders against a gateway new enough to serve it; the
    // story stands in for both.
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    const previous = useAssistantIdentityStore.getState().version;
    useAssistantIdentityStore.setState({ version: TRUST_FLOORS_VERSION });
    return () => {
      useAssistantIdentityStore.setState({ version: previous });
    };
  },
  decorators: [withEmailQueryCache],
};

export default meta;
type Story = StoryObj<typeof EmailSettingsModal>;

/** The address ready on a verified domain, open to verified contacts. */
export const Ready: Story = {};
