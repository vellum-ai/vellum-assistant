import type { Meta, StoryObj } from "@storybook/react-vite";

import { SlackSetupWizard } from "./slack-setup-wizard";
import { SLACK_MANIFEST_BOT_SCOPES } from "@/utils/slack-manifest";
import type { SlackScopeProbeResult } from "@/utils/slack-scope-probe";

const meta: Meta<typeof SlackSetupWizard> = {
  title: "Contacts/SlackSetupWizard",
  component: SlackSetupWizard,
  args: {
    assistantName: "Example Assistant",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 800, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SlackSetupWizard>;

/**
 * Stand in for the real probe. Stories never reach the Slack API — the wizard
 * only runs this once `saveStatus` is `success`, so the finish states below are
 * driven entirely by these fixtures.
 */
function stubProbe(result: SlackScopeProbeResult) {
  return () => Promise.resolve(result);
}

const ALL_GRANTED: SlackScopeProbeResult = {
  status: "complete",
  grantedScopes: [...SLACK_MANIFEST_BOT_SCOPES],
  missingScopes: [],
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

// The live-test symptom: 2 of 18 scopes on a token that passed auth.test.
const SILENTLY_DROPPED: SlackScopeProbeResult = {
  status: "incomplete",
  grantedScopes: ["chat:write", "im:history"],
  missingScopes: SLACK_MANIFEST_BOT_SCOPES.filter(
    (s) => s !== "chat:write" && s !== "im:history",
  ),
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

const UNREADABLE: SlackScopeProbeResult = {
  status: "unknown",
  grantedScopes: [],
  missingScopes: [],
  appId: null,
  reinstallUrl: "https://api.slack.com/apps",
};

export const Default: Story = {};

export const Saving: Story = {
  args: { saveStatus: "pending" },
};

/** Happy path — every requested scope came back, so setup reads as done. */
export const Connected: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(ALL_GRANTED) },
};

/** Scope drift — the probe surfaces the reinstall nudge. */
export const ConnectedWithScopeDrift: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(SILENTLY_DROPPED) },
};

/**
 * The probe couldn't read `x-oauth-scopes` (cross-origin). It stays quiet
 * rather than accusing Slack of dropping scopes it can't see.
 */
export const ConnectedProbeInconclusive: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(UNREADABLE) },
};

export const SaveFailed: Story = {
  args: {
    saveStatus: "error",
    saveError: "Slack rejected the bot token (invalid_auth).",
  },
};

/**
 * Token-format validation. Both fields reject a value that doesn't carry the
 * right prefix; play through it by pasting an `xapp-` token into Bot Token.
 */
export const TokenFormatValidation: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Paste "xapp-123" into Bot Token to see the prefix error, and a short ' +
          'value like "xoxb-123" to see the truncated-paste error. Connect stays ' +
          "disabled until both tokens are well-formed.",
      },
    },
  },
};
