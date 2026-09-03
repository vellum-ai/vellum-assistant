import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

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

/** Turns the model-first create flow on for one story, and off again after. */
function withModelFirstCreate() {
  const previous =
    useClientFeatureFlagStore.getState().modelFirstProfileCreate === true;
  useClientFeatureFlagStore.setState({ modelFirstProfileCreate: true });
  return () => {
    useClientFeatureFlagStore.setState({ modelFirstProfileCreate: previous });
  };
}

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

/**
 * The same create modal under `model-first-profile-create`: it opens on one
 * list of models rather than a provider dropdown, and asks nothing else until
 * a model is chosen.
 */
export const CreateModelFirst: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
};

/**
 * The open model list. Sections are named for whoever made the model, spelled
 * the way that vendor spells it, and each heading stays pinned while its own
 * rows scroll under it. The row that unfolds a section's older versions is
 * drawn as a secondary action, not as one more model.
 */
export const CreateModelFirstListOpen: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Model" }),
    );
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  },
};

/**
 * The list reopened over the answer to its own question. The dialog is at its
 * shortest here, since one connected route is stated in a line rather than
 * offered as cards, and the list still opens inside it: bounded by the body,
 * clear of the footer, and no shorter than it can be read at.
 */
export const CreateModelFirstListReopened: Story = {
  args: { mode: "create", connections: [connection("gemini")] },
  beforeEach: withModelFirstCreate,
  play: async () => {
    const modelField = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(modelField);
    await userEvent.click(
      await screen.findByRole("option", { name: /Gemini 3\.6 Flash/ }),
    );
    await waitFor(() =>
      expect(screen.getByText("Only Google Gemini serves this model.")).toBeTruthy(),
    );
    await userEvent.click(modelField);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  },
};

/**
 * The same open list in a window too short to hold it. The dialog stops at
 * its own ceiling, the body scrolls instead of growing, and the list caps
 * itself to what is left of the body, so Cancel and Save stay on screen.
 */
export const CreateModelFirstListOpenShort: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  globals: { viewport: { value: "sbShort", isRotated: false } },
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Model" }),
    );
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  },
};

/**
 * A model id typed by hand, which every route there is can serve. The cards
 * scroll inside the dialog rather than growing it, so what the dialog asks of
 * the window stays a fraction of it and the footer keeps clear of its edge.
 */
export const CreateModelFirstCustomId: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Model" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Enter a custom model ID…" }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("provider-candidate").length).toBeGreaterThan(
        5,
      ),
    );
  },
};

/**
 * A section with the rest of its models revealed: the block its heading's own
 * disclosure opened is set off by a hairline, and the list stays where the
 * user left it.
 */
export const CreateModelFirstSeeMore: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Model" }),
    );
    // Scoped to the section: every section that folds anything offers a row
    // of the same shape, spelled the same way.
    const anthropic = await screen.findByRole("group", { name: "Anthropic" });
    await userEvent.click(
      within(anthropic).getByRole("option", { name: "See more" }),
    );
    await waitFor(() =>
      expect(
        within(anthropic).getByRole("option", { name: /Claude Opus 4\.8/ }),
      ).toBeTruthy(),
    );
  },
};

/**
 * A route with no connection yet. Its card carries the key form, so the tag
 * that asked for the key steps aside and the form's own dismiss action says
 * what it dismisses rather than repeating the dialog's Cancel.
 */
export const CreateModelFirstConnectForm: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  play: async () => {
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Model" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /Claude Opus 5/ }),
    );
    await userEvent.click(
      await screen.findByRole("radio", { name: /OpenRouter/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel setup" })).toBeTruthy(),
    );
  },
};

/**
 * A model several connected providers serve. The routes become cards, the
 * first connected one is already chosen, and the rest carry what they need.
 */
export const CreateModelFirstSeveralProviders: Story = {
  args: { mode: "create" },
  beforeEach: withModelFirstCreate,
  play: async () => {
    const modelField = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(modelField);
    await userEvent.click(
      await screen.findByRole("option", { name: /Claude Opus 5/ }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("radio").length).toBeGreaterThan(1),
    );
  },
};

/**
 * A model only one connected provider serves. There is nothing to decide, so
 * the route is stated rather than offered and the flow goes straight to
 * Advanced.
 */
export const CreateModelFirstSingleProvider: Story = {
  args: { mode: "create", connections: [connection("gemini")] },
  beforeEach: withModelFirstCreate,
  play: async () => {
    const modelField = await screen.findByRole("combobox", { name: "Model" });
    await userEvent.click(modelField);
    await userEvent.click(
      await screen.findByRole("option", { name: /Gemini 3\.6 Flash/ }),
    );
    await waitFor(() =>
      expect(screen.getByText("Only Google Gemini serves this model.")).toBeTruthy(),
    );
  },
};
