import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { CodingAgentsCard } from "@/domains/settings/ai/coding-agents-card";
import { configGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/acp-model-switching";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "story-assistant";

/** No `acp` section at all: what a config that never picked a model looks like. */
const NO_MODEL_CONFIG: ConfigGetResponse = {};

const ALIAS_CONFIG: ConfigGetResponse = { acp: { defaultModel: "opus" } };

// A full model id rather than one of the resolver aliases the picker lists.
// The adapter accepts both, so the card has to keep a value it cannot offer.
const CUSTOM_CONFIG: ConfigGetResponse = {
  acp: { defaultModel: "claude-opus-4-5-20260301" },
};

// Storybook has no daemon, so the config query is seeded through the generated
// factory; HeyAPI bakes the path params into the key, so a hand-written key
// would miss and the card would render against an empty config.
function seededClient(config: ConfigGetResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      },
    },
  });
  client.setQueryData(
    configGetOptions({ path: { assistant_id: ASSISTANT_ID } }).queryKey,
    config,
  );
  return client;
}

/** Wraps a story in a provider seeded with `config`. */
function withConfig(config: ConfigGetResponse) {
  const client = seededClient(config);
  return function ConfigDecorator(Story: () => ReactNode) {
    return (
      <QueryClientProvider client={client}>
        <div style={{ maxWidth: 640, padding: 24 }}>
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

/**
 * Pins the active assistant and the version the ACP model-switching gate
 * reads, then puts both stores back.
 *
 * Both stores are module singletons, so seeding in `beforeEach` rather than
 * during a decorator's render keeps the write out of the render pass, where
 * two mounted variants would race and the last one would win. Without the
 * version the gate is closed and the card renders nothing at all.
 */
function seedAssistant() {
  const identity = useAssistantIdentityStore.getState();
  const previousActive =
    useResolvedAssistantsStore.getState().activeAssistantId;
  useAssistantIdentityStore.setState({
    version: MIN_VERSION,
    assistantId: ASSISTANT_ID,
  });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  return () => {
    useAssistantIdentityStore.setState({
      version: identity.version,
      assistantId: identity.assistantId,
    });
    useResolvedAssistantsStore.setState({ activeAssistantId: previousActive });
  };
}

const meta: Meta<typeof CodingAgentsCard> = {
  title: "Settings/AI/CodingAgentsCard",
  component: CodingAgentsCard,
  beforeEach: seedAssistant,
};

export default meta;
type Story = StoryObj<typeof CodingAgentsCard>;

/**
 * Nothing stored: the picker sits on the agent-default row, which writes
 * `null` and leaves model selection to the adapter. Save is disabled until
 * the choice differs from what the daemon holds.
 */
export const Default: Story = {
  decorators: [withConfig(NO_MODEL_CONFIG)],
};

/** A stored alias from claude-agent-acp's own vocabulary. */
export const AliasSelected: Story = {
  decorators: [withConfig(ALIAS_CONFIG)],
};

/**
 * A stored value the picker does not list. The card opens on the Custom row
 * with the text input pre-filled rather than silently dropping a setting it
 * cannot name, which is what makes a second adapter usable before its models
 * have entries here.
 */
export const CustomModel: Story = {
  decorators: [withConfig(CUSTOM_CONFIG)],
};

/**
 * An unsaved choice. Picking a model the daemon does not hold is what enables
 * Save, so this is the state a user reaches before the write.
 *
 * The play stops at the enabled button: Storybook has no daemon and this repo
 * has no request mock for stories, so clicking Save would post into the void.
 */
export const Dirty: Story = {
  decorators: [withConfig(NO_MODEL_CONFIG)],
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Default model" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Haiku" }));
    await waitFor(() => {
      const save = screen.getByRole("button", {
        name: "Save",
      }) as HTMLButtonElement;
      expect(save.disabled).toBe(false);
    });
  },
};
