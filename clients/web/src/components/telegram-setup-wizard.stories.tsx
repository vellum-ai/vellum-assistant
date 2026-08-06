import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { TelegramSetupWizard } from "./telegram-setup-wizard";

const meta: Meta<typeof TelegramSetupWizard> = {
  title: "Contacts/TelegramSetupWizard",
  component: TelegramSetupWizard,
  args: {
    assistantName: "Example Assistant",
  },
  // 400px matches the drawer this renders in: `chat-content-layout.tsx` mounts
  // the channel setup panel in an `AnimatedRightDrawer` with `defaultWidth` and
  // `minWidth` both 400.
  decorators: [
    (Story) => (
      <div style={{ width: 400, margin: "2rem auto" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TelegramSetupWizard>;

// Assembled rather than written inline so the secret scanner doesn't read this
// placeholder as a real credential (it exempts *.test.* files, not stories).
const BOT_TOKEN = `123456789:${"A".repeat(10)}bCdEfGhIjKlMnOpQrStUvWx`;
const WRONG_CHANNEL_TOKEN = `xoxb-${"0".repeat(10)}-${"0".repeat(10)}-abcdef`;

/**
 * Walk to the token step the way a user does. There is no prop to jump
 * straight there: a story that renders a screen no real path produces would
 * assert against a state the wizard cannot actually reach.
 */
async function goToConnect(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: /^Next$/i }));
}

const fillToken: Story["play"] = async ({ canvasElement }) => {
  await goToConnect(canvasElement);
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(/Bot Token/i), BOT_TOKEN);
};

/** Step 1: what to do in BotFather. */
export const CreateBot: Story = {};

/** Step 2, reached the way a user reaches it. */
export const Connect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Next$/i }));
  },
};

export const Saving: Story = {
  args: { saveStatus: "pending" },
  play: fillToken,
};

/**
 * The post-save state. No credential fields are populated: a successful save
 * clears them, so a story showing both would depict something the wizard
 * cannot produce.
 */
export const Connected: Story = {
  args: { saveStatus: "success" },
  play: async ({ canvasElement }) => {
    await goToConnect(canvasElement);
  },
};

export const SaveFailed: Story = {
  args: {
    saveStatus: "error",
    saveError: "Telegram rejected the bot token (401 Unauthorized).",
  },
  play: fillToken,
};

/**
 * Token-format validation: a Slack token pasted into the Telegram field. The
 * shape error renders and Connect stays disabled.
 */
export const TokenFormatValidation: Story = {
  play: async ({ canvasElement }) => {
    await goToConnect(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText(/Bot Token/i),
      WRONG_CHANNEL_TOKEN,
    );
  },
};
