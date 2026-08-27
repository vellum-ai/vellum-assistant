/**
 * The wizard's email step, where a fresh Pro subscriber claims a subdomain for
 * their assistant.
 *
 * `locked` decides whether a domain is already registered: the handle is
 * immutable once set, so the fields go read-only and the two actions collapse
 * into a single "Continue". `machineBusy` holds "Next" while the machine is
 * still restarting behind the webhook-driven resize, because registering the
 * email writes to the machine's gateway.
 *
 * `DomainStep` renders a `Modal.Body` / `Modal.Footer` pair rather than a
 * standalone card, so the decorator mounts the same `Modal.Root` /
 * `Modal.Content` box `BillingOnboardingModal` gives it, and answers the
 * assistant and domain reads from a story-local cache keyed on `locked` so the
 * toggle works live.
 *
 * "Next" posts to the onboarding domain endpoint for real. Storybook has no
 * platform to answer it, so the request fails and the step surfaces its error
 * message; "Skip" posts too and exits on either outcome.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect } from "react";

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

const STORY_ASSISTANT_ID = "story-assistant-domain";

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

const domainsQueryKey = assistantsDomainsListQueryKey({
  path: { assistant_id: STORY_ASSISTANT_ID },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

queryClient.setQueryData(
  assistantsRetrieveQueryKey({ path: { id: STORY_ASSISTANT_ID } }),
  makeStoryAssistant(STORY_ASSISTANT_ID),
);

/**
 * Answers the domains read the way the `locked` control says. The write sits in
 * an effect keyed on the arg because the step subscribes to this cache, and the
 * entry is dropped on unmount so nothing seeded here outlives the story.
 */
const domainsDecorator: Decorator<{ locked: boolean }> = function SeededDomains(
  Story,
  context,
) {
  const { locked } = context.args;
  useLayoutEffect(() => {
    queryClient.setQueryData(domainsQueryKey, locked ? ONE_DOMAIN : NO_DOMAINS);
    return () => {
      queryClient.removeQueries({ queryKey: domainsQueryKey });
    };
  }, [locked]);
  return <Story />;
};

/** Story-local controls; `locked` drives the seeded cache, not a prop. */
interface DomainStepStoryArgs {
  locked: boolean;
  machineBusy: boolean;
}

function renderDomainStep(args: DomainStepStoryArgs) {
  return (
    <DomainStep
      assistantId={STORY_ASSISTANT_ID}
      machineBusy={args.machineBusy}
      onExit={() => {}}
    />
  );
}

const meta: Meta<DomainStepStoryArgs> = {
  title: "Settings/Billing/ProOnboarding/DomainStep",
  // A portaled modal overlay is `fixed`, so one docs iframe cannot show this
  // story beside its neighbours.
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    locked: {
      description: "A domain is already registered, which locks the step.",
      control: "boolean",
    },
    machineBusy: {
      description: 'The assistant machine is restarting, which holds "Next".',
      control: "boolean",
    },
  },
  args: {
    locked: false,
    machineBusy: false,
  },
  render: renderDomainStep,
  // Storybook applies decorators innermost first, so the cache is seeded before
  // the step below it reads.
  decorators: [
    (Story) => (
      <WizardStepBox hideCloseButton>
        <Story />
      </WizardStepBox>
    ),
    domainsDecorator,
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<DomainStepStoryArgs>;

/** The step, driven from the Controls panel. */
export const Playground: Story = {};
