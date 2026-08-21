/**
 * Visual reference for the sidebar's assistant switcher (Figma 7984:9239).
 *
 * The switcher derives everything from stores: the switchable list and each
 * row's avatar. Every story therefore seeds the resolved assistants, a live
 * platform session, and a query cache carrying one character avatar per
 * entry; a story that seeds a single assistant shows the affordance-free pill
 * the short list collapses to.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSwitcher } from "@/domains/chat/components/assistant-switcher";
import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import { useAuthStore } from "@/stores/auth-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

function platformAssistant(id: string, name: string): ResolvedAssistant {
  return { id, name, isLocal: false, isPlatformHosted: true, isPaired: false };
}

const ASSISTANTS: ResolvedAssistant[] = [
  platformAssistant("asst-1", "Alice"),
  platformAssistant("asst-2", "Bob"),
  platformAssistant("asst-3", "Carol"),
];

const TRAITS: Record<string, CharacterTraits> = {
  "asst-1": { bodyShape: "blob", eyeStyle: "curious", color: "teal" },
  "asst-2": { bodyShape: "star", eyeStyle: "goofy", color: "green" },
  "asst-3": { bodyShape: "burst", eyeStyle: "surprised", color: "pink" },
};

/* One client for every story: the seeds are per-assistant-id and the stories
   share the ids. Both spellings of the key carry each avatar, since the hook
   appends its manifest-support flag and a story cannot know which way that
   resolves. */
const AVATAR_CLIENT = (() => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [id, traits] of Object.entries(TRAITS)) {
    for (const supportsManifest of [true, false]) {
      client.setQueryData([...avatarQueryKey(id), supportsManifest], {
        components: BUNDLED_COMPONENTS,
        traits,
        customImageUrl: null,
      } satisfies AvatarData);
    }
  }
  return client;
})();

function seedStores(assistants: ResolvedAssistant[]): void {
  useResolvedAssistantsStore.setState({
    assistants,
    assistantsHydrated: true,
    activeAssistantId: "asst-1",
  });
  /* `useSwitchableAssistants` only counts platform entries where a platform
     session is live; a story has no session of its own. */
  useAuthStore.setState({ platformSession: "present" });
}

const meta: Meta<typeof AssistantSwitcher> = {
  title: "Chat/AssistantSwitcher",
  component: AssistantSwitcher,
  args: {
    assistantId: "asst-1",
    label: "Alice",
    active: false,
    collapsed: false,
    onSelect: () => {},
    onNewConversation: () => {},
  },
  decorators: [
    (Story: () => ReactElement) => {
      seedStores(ASSISTANTS);
      return (
        <QueryClientProvider client={AVATAR_CLIENT}>
          <div className="w-[280px] rounded-2xl bg-[var(--surface-base)] p-3">
            <Story />
          </div>
        </QueryClientProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof AssistantSwitcher>;

/** The resting pill with the switcher's chevron beside the name. */
export const Default: Story = {};

/** The expanded card: the current entry checked, the rest one tap away. */
export const Expanded: Story = {
  args: { defaultExpanded: true },
};

/** A single switchable assistant renders the plain pill, chevron-free. */
export const SingleAssistant: Story = {
  decorators: [
    (Story: () => ReactElement) => {
      seedStores(ASSISTANTS.slice(0, 1));
      return <Story />;
    },
  ],
};
