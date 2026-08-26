/**
 * The wizard's email step, where a fresh Pro subscriber claims a subdomain for
 * their assistant.
 *
 * `DomainStep` renders a `Modal.Body` / `Modal.Footer` pair rather than a
 * standalone card, so the decorator mounts the same `Modal.Root` /
 * `Modal.Content` box `BillingOnboardingModal` gives it. The handle prefills
 * from the assistant, so every story seeds one.
 *
 * "Next" posts to the onboarding domain endpoint for real. Storybook has no
 * platform to answer it, so the request fails and the step surfaces its error
 * message; "Skip" posts too and exits on either outcome.
 *
 * `tags: ["!autodocs"]` because a modal's overlay is `fixed`: all three stories
 * share one docs iframe, so they would stack on top of each other there.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  assistantsDomainsListQueryKey,
  assistantsRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { PaginatedAssistantDomainList } from "@/generated/api/types.gen";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { DomainStep } from "./domain-step";
import { makeStoryAssistant, WizardStepBox } from "./wizard-step-story-support";

// Three bundled creatures hang off the card's top edge, from a dynamic import.
preloadBundledAvatarComponents();

/** The assistant with no domain yet, whose handle prefills the field. */
const OPEN_ASSISTANT_ID = "story-assistant-domain-open";
/** The assistant that already registered one, which locks the step. */
const LOCKED_ASSISTANT_ID = "story-assistant-domain-locked";

const NO_DOMAINS: PaginatedAssistantDomainList = {
  count: 0,
  next: null,
  previous: null,
  results: [],
};

const ONE_DOMAIN: PaginatedAssistantDomainList = {
  count: 1,
  next: null,
  previous: null,
  results: [
    {
      id: "story-domain-1",
      subdomain: "velly",
      created: "2026-07-01T00:00:00Z",
      modified: "2026-07-01T00:00:00Z",
    },
  ],
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

for (const [id, domains] of [
  [OPEN_ASSISTANT_ID, NO_DOMAINS],
  [LOCKED_ASSISTANT_ID, ONE_DOMAIN],
] as const) {
  queryClient.setQueryData(
    assistantsRetrieveQueryKey({ path: { id } }),
    makeStoryAssistant(id),
  );
  queryClient.setQueryData(
    assistantsDomainsListQueryKey({ path: { assistant_id: id } }),
    domains,
  );
}

const meta: Meta<typeof DomainStep> = {
  title: "Settings/Billing/ProOnboarding/DomainStep",
  component: DomainStep,
  // See the file header: a portaled modal overlay is `fixed`, so one docs
  // iframe cannot show these stories side by side.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    assistantId: OPEN_ASSISTANT_ID,
    machineBusy: false,
    onExit: () => {},
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <WizardStepBox hideCloseButton>
          <Story />
        </WizardStepBox>
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DomainStep>;

/** The step as it opens: the handle prefilled, both actions live. */
export const Idle: Story = {
  name: "Idle",
};

/**
 * The machine is still restarting behind the webhook-driven resize. Registering
 * the email writes to the machine's gateway, so "Next" is held until it is back
 * and a notice says why.
 */
export const MachineBusy: Story = {
  name: "Machine busy",
  args: {
    machineBusy: true,
  },
};

/**
 * A domain is already registered. The handle is immutable once set, so the
 * fields go read-only and the two actions collapse into a single "Continue".
 */
export const Locked: Story = {
  name: "Locked",
  args: {
    assistantId: LOCKED_ASSISTANT_ID,
  },
};
