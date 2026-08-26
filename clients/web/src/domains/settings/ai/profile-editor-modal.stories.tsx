import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

function connection(provider: string): ProviderConnection {
  return {
    name: provider,
    label: null,
    provider,
    // The auth shape is load-bearing: the Model field reads it to decide
    // whether the connection restricts the model set, so a fixture without
    // it takes the picker down as soon as a provider is chosen.
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    models: null,
  } as unknown as ProviderConnection;
}

const CONNECTIONS: ProviderConnection[] = [
  connection("anthropic"),
  connection("openai"),
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

/**
 * Create starts blank, so it must not flag empty fields before any input.
 * The body asks two questions: which provider, and which model.
 */
export const Create: Story = {
  args: { mode: "create" },
};

/**
 * With a model chosen, Advanced appears. Opening it shows what the model has
 * already answered for the user: the Name, filled in from the model, above
 * the parameters that model supports.
 */
export const CreateAdvanced: Story = {
  args: { mode: "create" },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Provider" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /Anthropic/ }));

    const modelField = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(modelField);
    await userEvent.click(
      await screen.findByRole("option", { name: "Claude Opus 4.8" }),
    );

    const advanced = await screen.findByRole("button", { name: "Advanced" });
    await userEvent.click(advanced);
    await waitFor(() =>
      expect(screen.getByDisplayValue("Claude Opus 4.8")).toBeTruthy(),
    );
  },
};

/**
 * A second profile on the same model. The Name it is given steps around the
 * one already taken rather than colliding with it.
 */
export const CreateDuplicateName: Story = {
  args: { mode: "create", existingNames: ["claude-opus-4-8"] },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Provider" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /Anthropic/ }));

    const modelField = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(modelField);
    await userEvent.click(
      await screen.findByRole("option", { name: "Claude Opus 4.8" }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("Claude Opus 4.8 (2)")).toBeTruthy(),
    );
  },
};
