import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

const CONNECTIONS: ProviderConnection[] = [
  { name: "anthropic", provider: "anthropic" } as ProviderConnection,
  { name: "openai", provider: "openai" } as ProviderConnection,
];

const meta: Meta<typeof ProfileEditorModal> = {
  title: "Settings/AI/ProfileEditorModal",
  component: ProfileEditorModal,
  args: {
    isOpen: true,
    existingNames: ["balanced", "fast"],
    connections: CONNECTIONS,
    assistantId: "asst-1",
    onSave: async () => {},
    onCancel: () => {},
  },
  parameters: {
    // The modal owns the viewport; a centered frame just fights it.
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ProfileEditorModal>;

/** Editing a complete profile: no field is blocking, Save is available. */
export const Edit: Story = {
  args: {
    mode: "edit",
    profileName: "balanced",
    initialValues: {
      name: "balanced",
      label: "Balanced",
      provider: "anthropic",
      model: "claude-opus-5",
      status: "active",
    },
  },
};

/**
 * The state the Profiles list links here for. The profile names no provider,
 * so the resolver skips it and actions fall through to their default. Save is
 * disabled, and the Provider field has to say why. A dead button with no
 * explanation is the bug this covers (LUM-3076).
 */
export const MissingProvider: Story = {
  args: {
    mode: "edit",
    profileName: "half-built",
    initialValues: {
      name: "half-built",
      label: "Half Built",
      status: "active",
    },
  },
};

/**
 * The Model field already explains this state itself, keyed to why it is
 * empty. Here to prove the two messages do not double up.
 */
export const MissingModel: Story = {
  args: {
    mode: "edit",
    profileName: "half-built",
    initialValues: {
      name: "half-built",
      label: "Half Built",
      provider: "anthropic",
      status: "active",
    },
  },
};

/** Create starts blank, so it must not flag empty fields before any input. */
export const Create: Story = {
  args: { mode: "create" },
};
