import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { ProfileQuickAddProvider } from "@/components/profile-quick-add-provider";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-story";

/**
 * Enough profiles to overflow the popover, which is the point of the story:
 * the list is capped at about seven rows and scrolls, rather than running off
 * the top of the composer.
 */
const PROFILE_LABELS = [
  "Balanced",
  "OS Beta",
  "Quality",
  "Cost",
  "Speed",
  "Quality 5.5",
  "Quality-Claude",
  "GLM-5.2",
  "GPT-5.6 Sol-low-thinking",
  "Quality-Fable",
  "Notch Fast",
  "Deep Research",
];

function profileKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildConfig(labels: string[]) {
  const profiles = Object.fromEntries(
    labels.map((label) => [
      profileKey(label),
      {
        label,
        provider: "anthropic",
        model: "claude-opus-4-8",
        status: "active",
      },
    ]),
  );
  return {
    llm: {
      activeProfile: profileKey(labels[0] ?? "balanced"),
      profileOrder: labels.map(profileKey),
      profiles,
    },
  };
}

/**
 * Seeds the config query the menu reads its profiles from, so the story needs
 * no daemon. The threshold fetches are left to fail: with no access level the
 * menu renders the profile segment alone, which is what these stories are of.
 */
function SeedConfig({
  labels,
  children,
}: {
  labels: string[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    queryClient.setQueryData(
      configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      buildConfig(labels),
    );
    setSeeded(true);
  }, [queryClient, labels]);
  return seeded ? children : null;
}

const meta: Meta<typeof ComposerSettingsMenu> = {
  title: "Chat/ComposerSettingsMenu",
  component: ComposerSettingsMenu,
  args: {
    assistantId: ASSISTANT_ID,
    conversationId: undefined,
    segments: "profile",
  },
  parameters: {
    // The popover opens upward from the composer, so the story needs room
    // below the trigger the way the real action row has it.
    layout: "fullscreen",
  },
  decorators: [
    (Story, context) => (
      <ProfileQuickAddProvider>
        <SeedConfig labels={context.parameters.profileLabels ?? PROFILE_LABELS}>
          <div className="flex h-[560px] items-end justify-center p-6">
            <Story />
          </div>
        </SeedConfig>
      </ProfileQuickAddProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ComposerSettingsMenu>;

async function openProfileMenu() {
  const trigger = await screen.findByRole("button", {
    name: /Model profile/,
  });
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
}

/** The trigger at rest, showing the active profile. */
export const Closed: Story = {};

/**
 * A long profile list. The rows scroll inside the popover instead of growing
 * it past the top of the window, and the edge fade says there is more below.
 */
export const OpenWithManyProfiles: Story = {
  play: openProfileMenu,
};

/** A list short enough to fit needs no scrolling and shows no fade. */
export const OpenWithFewProfiles: Story = {
  parameters: { profileLabels: PROFILE_LABELS.slice(0, 3) },
  play: openProfileMenu,
};
