import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { SlackSetupWizard } from "./slack-setup-wizard";
import {
  SLACK_MANIFEST_BOT_SCOPES,
  SLACK_MANIFEST_BOT_SCOPES_OPTIONAL,
} from "@/utils/slack-manifest";
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
 * runs this once `saveStatus` is `success` and a bot token is present, so the
 * finish states below are driven entirely by these fixtures.
 */
function stubProbe(result: SlackScopeProbeResult) {
  return () => Promise.resolve(result);
}

// Assembled rather than written inline so the secret scanner doesn't read these
// placeholders as real credentials (it exempts *.test.* files, not stories).
const DIGITS = "0".repeat(10);
const BOT_TOKEN = `xoxb-${DIGITS}-${DIGITS}-abcdefghij`;
const APP_TOKEN = `xapp-1-A${DIGITS}-${DIGITS}-abcdefghij`;

/**
 * The wizard probes the bot token the user pasted, so a finish state is only
 * reachable once the fields are filled. Type them the way a user would.
 */
const fillTokens: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(/Bot Token/i), BOT_TOKEN);
  await userEvent.type(canvas.getByLabelText(/App Token/i), APP_TOKEN);
};

const ALL_GRANTED: SlackScopeProbeResult = {
  status: "complete",
  grantedScopes: [...SLACK_MANIFEST_BOT_SCOPES],
  missingScopes: [],
  missingRequiredScopes: [],
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

const OPTIONAL_DECLINED: SlackScopeProbeResult = {
  status: "degraded",
  grantedScopes: SLACK_MANIFEST_BOT_SCOPES.filter(
    (s) => !SLACK_MANIFEST_BOT_SCOPES_OPTIONAL.includes(
      s as (typeof SLACK_MANIFEST_BOT_SCOPES_OPTIONAL)[number],
    ),
  ),
  missingScopes: [...SLACK_MANIFEST_BOT_SCOPES_OPTIONAL],
  missingRequiredScopes: [],
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
  missingRequiredScopes: SLACK_MANIFEST_BOT_SCOPES.filter(
    (s) =>
      s !== "chat:write" &&
      s !== "im:history" &&
      !SLACK_MANIFEST_BOT_SCOPES_OPTIONAL.includes(
        s as (typeof SLACK_MANIFEST_BOT_SCOPES_OPTIONAL)[number],
      ),
  ),
  appId: "A0EXAMPLE",
  reinstallUrl: "https://api.slack.com/apps/A0EXAMPLE/oauth",
};

const UNREADABLE: SlackScopeProbeResult = {
  status: "unknown",
  grantedScopes: [],
  missingScopes: [],
  missingRequiredScopes: [],
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
  play: fillTokens,
};

/** Silent drop — mandatory scopes are missing, so the reinstall nudge fires. */
export const ConnectedWithScopeDrift: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(SILENTLY_DROPPED) },
  play: fillTokens,
};

/**
 * The workspace declined the optional scopes on Slack's consent screen. Their
 * choice is reported without a reinstall prompt — reinstalling would only
 * replay the same screen and earn the same answer.
 */
export const ConnectedWithOptionalDeclined: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(OPTIONAL_DECLINED) },
  play: fillTokens,
};

/**
 * The probe couldn't read `x-oauth-scopes` (cross-origin). It stays quiet
 * rather than accusing Slack of dropping scopes it can't see.
 */
export const ConnectedProbeInconclusive: Story = {
  args: { saveStatus: "success", probeScopes: stubProbe(UNREADABLE) },
  play: fillTokens,
};

export const SaveFailed: Story = {
  args: {
    saveStatus: "error",
    saveError: "Slack rejected the bot token (invalid_auth).",
  },
};

/**
 * Token-format validation. Bot Token holds an `xapp-` value (wrong prefix) and
 * App Token holds a truncated one, so both error styles render at once and
 * Connect stays disabled.
 */
export const TokenFormatValidation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // An app token in the bot field: right shape, wrong prefix.
    await userEvent.type(canvas.getByLabelText(/Bot Token/i), APP_TOKEN);
    await userEvent.type(canvas.getByLabelText(/App Token/i), "xapp-123");
  },
};
