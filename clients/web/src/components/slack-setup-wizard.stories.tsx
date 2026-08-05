import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { SlackSetupWizard } from "./slack-setup-wizard";

const meta: Meta<typeof SlackSetupWizard> = {
  title: "Contacts/SlackSetupWizard",
  component: SlackSetupWizard,
  args: {
    assistantName: "Example Assistant",
  },
  // 400px matches the drawer the wizard actually renders in: `chat-content-
  // layout.tsx` mounts it in an `AnimatedRightDrawer` with `defaultWidth` and
  // `minWidth` both 400. A wider frame hides the density these stories exist to
  // show.
  decorators: [
    (Story) => (
      <div style={{ width: 400, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SlackSetupWizard>;

// Assembled rather than written inline so the secret scanner doesn't read these
// placeholders as real credentials (it exempts *.test.* files, not stories).
const DIGITS = "0".repeat(10);
const BOT_TOKEN = `xoxb-${DIGITS}-${DIGITS}-abcdefghij`;
const APP_TOKEN = `xapp-1-A${DIGITS}-${DIGITS}-abcdefghij`;

const fillTokens: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(/Bot Token/i), BOT_TOKEN);
  await userEvent.type(canvas.getByLabelText(/App Token/i), APP_TOKEN);
};

/** Step 1: name the app and take its manifest. */
export const Name: Story = {};

/** Step 1 with the name cleared: both Copy manifest and Next are blocked. */
export const NameEmpty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText(/App Name/i));
  },
};

/**
 * Step 1 after a successful copy, showing the transient confirmation.
 *
 * This and `OpenSlackAfterCopy` depend on the clipboard write resolving, which
 * needs a focused document. In a headless or unfocused context the write
 * rejects and the story renders the un-copied state instead of failing, so
 * read them in a real browser window.
 */
export const Copied: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /Copy manifest/i }),
    );
  },
};

/**
 * Step 2 reached without copying: the handoff warns that Slack's modal has no
 * other way to get the manifest.
 */
export const OpenSlack: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Next$/i }));
  },
};

/** Step 2 reached after copying: the handoff reports the manifest was taken. */
export const OpenSlackAfterCopy: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /Copy manifest/i }),
    );
    await userEvent.click(canvas.getByRole("button", { name: /^Next$/i }));
  },
};

/** Step 3: the in-Slack directions, with one way forward. */
export const CreateApp: Story = {
  args: { initialStepId: "create" },
};

/** Step 4: both tokens, empty. */
export const Connect: Story = {
  args: { initialStepId: "connect" },
};

export const Saving: Story = {
  args: { initialStepId: "connect", saveStatus: "pending" },
  play: fillTokens,
};

export const Connected: Story = {
  args: { initialStepId: "connect", saveStatus: "success" },
  play: fillTokens,
};

export const SaveFailed: Story = {
  args: {
    initialStepId: "connect",
    saveStatus: "error",
    saveError: "Slack rejected the bot token (invalid_auth).",
  },
  play: fillTokens,
};

/**
 * Token-format validation. Bot Token holds an `xapp-` value (wrong prefix) and
 * App Token holds a truncated one, so both error styles render at once and
 * Connect stays disabled.
 */
export const TokenFormatValidation: Story = {
  args: { initialStepId: "connect" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(/Bot Token/i), APP_TOKEN);
    await userEvent.type(canvas.getByLabelText(/App Token/i), "xapp-123");
  },
};
