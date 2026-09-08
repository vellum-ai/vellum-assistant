import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { HoverCapabilityOverride } from "@vellumai/design-library/utils/hover-capability";

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
const MANY_PROFILE_LABELS = [
  "Balanced",
  "OS Beta",
  "Quality",
  "Budget",
  "Fast",
  "Quality 5.5",
  "Quality-Claude",
  "GLM-5.2",
  "GPT-5.6 Sol-low-thinking",
  "Quality-Fable",
  "Notch Fast",
  "Deep Research",
];

const MANY_PROFILES: ProfileSeed[] = MANY_PROFILE_LABELS.map((label) => ({
  label,
}));

/**
 * The tier-named profiles Vellum seeds, paired with the model each one pins.
 * Only these carry their model beside the row, since a tier name says nothing
 * about what is about to run.
 */
const MANAGED_PROFILES: ProfileSeed[] = [
  {
    label: "Balanced",
    source: "managed",
    provider: "vellum",
    model: "accounts/fireworks/models/glm-5p2",
  },
  {
    label: "Quality",
    source: "managed",
    provider: "vellum",
    model: "gpt-5.6-sol",
  },
  {
    label: "Cost",
    source: "managed",
    provider: "vellum",
    model: "accounts/fireworks/models/deepseek-v4-flash-0731",
  },
  {
    label: "Speed",
    source: "managed",
    provider: "vellum",
    model: "gpt-5.6-luna",
  },
  { label: "GPT-5.6 Luna", source: "user" },
];

interface ProfileSeed {
  label: string;
  source?: "managed" | "user";
  provider?: string;
  model?: string;
}

function profileKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildConfig(seeds: ProfileSeed[]) {
  const profiles = Object.fromEntries(
    seeds.map((seed) => [
      profileKey(seed.label),
      {
        label: seed.label,
        provider: seed.provider ?? "anthropic",
        model: seed.model ?? "claude-opus-4-8",
        source: seed.source ?? "user",
        status: "active",
      },
    ]),
  );
  return {
    llm: {
      activeProfile: profileKey(seeds[0]?.label ?? "balanced"),
      profileOrder: seeds.map((seed) => profileKey(seed.label)),
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
  seeds,
  children,
}: {
  seeds: ProfileSeed[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    queryClient.setQueryData(
      configGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      buildConfig(seeds),
    );
    setSeeded(true);
  }, [queryClient, seeds]);
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
        <SeedConfig seeds={context.parameters.profileSeeds ?? MANY_PROFILES}>
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
 * it past the top of the window, and a top fade appears once you scroll to
 * say there is more above.
 */
export const OpenWithManyProfiles: Story = {
  play: openProfileMenu,
};

/** A list short enough to fit needs no scrolling and shows no fade. */
export const OpenWithFewProfiles: Story = {
  parameters: { profileSeeds: MANY_PROFILES.slice(0, 3) },
  play: openProfileMenu,
};

/**
 * The managed profiles alongside one the user made. Hovering a managed row
 * names the model it currently pins; the user's row is already named after
 * its own model, so it carries no label.
 */
export const OpenWithManagedProfiles: Story = {
  parameters: { profileSeeds: MANAGED_PROFILES },
  play: async (context) => {
    await openProfileMenu();
    const balanced = await screen.findByRole("menuitem", { name: "Balanced" });
    await userEvent.hover(balanced);
    await waitFor(() =>
      expect(context.canvasElement.ownerDocument.body.textContent).toContain(
        "GLM 5.2",
      ),
    );
  },
};

/**
 * The same menu on a device that cannot hover but is too wide for the bottom
 * sheet, an iPad in landscape being the case in hand. A tooltip mounts nothing
 * here, so each managed row carries its model inline instead.
 */
export const OpenWithManagedProfilesNoHover: Story = {
  parameters: { profileSeeds: MANAGED_PROFILES },
  decorators: [
    (Story) => (
      <HoverCapabilityOverride hoverCapable={false}>
        <Story />
      </HoverCapabilityOverride>
    ),
  ],
  play: async (context) => {
    await openProfileMenu();
    await waitFor(() =>
      expect(context.canvasElement.ownerDocument.body.textContent).toContain(
        "GLM 5.2",
      ),
    );
  },
};
