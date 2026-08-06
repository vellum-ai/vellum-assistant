import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProfileRow } from "@/domains/settings/ai/profile-row";
import type { InferenceProfileSummary } from "@/generated/daemon/types.gen";

// Shaped as `GET /v1/inference/profiles` returns them, which is what the
// Profiles section passes straight through.
function summary(
  over: Partial<InferenceProfileSummary> & { name: string },
): InferenceProfileSummary {
  return {
    label: null,
    provider: "anthropic",
    model: "claude-opus-5",
    status: "active",
    source: "user",
    availability: { status: "ok" },
    ...over,
  };
}

const meta: Meta<typeof ProfileRow> = {
  title: "Settings/AI/ProfileRow",
  component: ProfileRow,
  args: {
    isActiveProfile: false,
    selected: false,
    onOpen: () => {},
    onMakeActive: () => {},
    onSetStatus: () => {},
    onDelete: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ProfileRow>;

/** A user profile that can dispatch: no chips, no warning. */
export const Default: Story = {
  args: { profile: summary({ name: "my-custom", label: "My Custom" }) },
};

/** The `llm.activeProfile` row, carrying the Default chip. */
export const IsDefault: Story = {
  args: {
    profile: summary({
      name: "balanced",
      label: "Balanced",
      provider: "vellum",
      model: "glm-5.2",
      source: "managed",
    }),
    isActiveProfile: true,
  },
};

/** Dimmed title plus the Disabled chip. Still dispatchable if re-enabled. */
export const Disabled: Story = {
  args: {
    profile: summary({
      name: "retired",
      label: "Retired",
      status: "disabled",
    }),
  },
};

/**
 * A connection problem: the profile is complete, but the credential behind
 * its provider is missing. The warning is informational here rather than a
 * button, because the fix is in the connection settings and not the profile
 * editor this row opens. The server's message already names where to go, so
 * the tooltip does not add a "Click to fix" the click could not honor.
 */
export const ConnectionProblem: Story = {
  args: {
    profile: summary({
      name: "byok",
      label: "My OpenAI",
      provider: "openai",
      model: "gpt-5.5",
      availability: {
        status: "missing_credential",
        message:
          'Connection "openai-personal" has no stored API key. Add one in Settings, Models & Services.',
      },
    }),
  },
};

/**
 * The state this row previously showed nothing for.
 *
 * A profile carrying no model cannot dispatch: the resolver skips the rung
 * on every turn and the action quietly resolves elsewhere. Availability used
 * to report null here, which reads as healthy, so the profile looked fine in
 * settings while doing nothing everywhere else. It now reports `incomplete`
 * and lights up the same warning affordance as a connection problem.
 */
export const Incomplete: Story = {
  args: {
    profile: summary({
      name: "half-made",
      label: "Half Made",
      model: null,
      availability: {
        status: "incomplete",
        message:
          "Missing a model, so actions using it fall back to another profile.",
      },
    }),
  },
};

/**
 * A mix names other profiles instead of carrying its own provider and model,
 * so the daemon reports no verdict for it and the row stays clean. Judging a
 * mix by its own empty fields would flag every working one.
 */
export const Mix: Story = {
  args: {
    profile: summary({
      name: "ab-test",
      label: "A/B Test",
      provider: null,
      model: null,
      availability: null,
    }),
  },
};
