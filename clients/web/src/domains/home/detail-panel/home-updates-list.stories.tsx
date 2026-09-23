/**
 * `HomeUpdatesList` is the body of a skill-update receipt inside the bell's
 * detail. The decorator frames it at the detail's content width and padding,
 * so the wrapping of a summary beside its source link is seen as it ships.
 * The bell owns the validating reads, so the sets here are what it passes
 * down once `useFeedItemUpdateLinks` has resolved.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { HomeUpdatesList } from "@/domains/home/detail-panel/home-updates-list";
import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_SECOND_CONVERSATION_ID,
  FIXTURE_SKILL_UPDATES,
  skillUpdateReceipt,
} from "@/domains/home/feed-test-fixtures";

const meta = {
  title: "Home/HomeUpdatesList",
  component: HomeUpdatesList,
  parameters: { layout: "padded" },
  args: {
    item: skillUpdateReceipt({ id: "feed-skill-receipt" }),
    validSkillIds: new Set(
      FIXTURE_SKILL_UPDATES.map((update) => update.skillId),
    ),
    validConversationIds: new Set([
      FIXTURE_CONVERSATION_ID,
      FIXTURE_SECOND_CONVERSATION_ID,
    ]),
    isValidationPending: false,
    onNavigate: () => {},
    onGoToConversation: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[435px] rounded-[var(--radius-xl)] bg-[var(--surface-lift)] p-[var(--app-spacing-lg)] shadow-[var(--shadow-popover)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HomeUpdatesList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three skills, one rewritten twice, from two source conversations. */
export const Default: Story = {};

/**
 * A skill that has since been removed and a source conversation that was
 * garbage collected each read as text; the rest still link.
 */
export const TargetsGone: Story = {
  args: {
    validSkillIds: new Set(["approved-pr-merge-gate", "weekly-report-export"]),
    validConversationIds: new Set([FIXTURE_CONVERSATION_ID]),
  },
};

/**
 * The window between opening the detail and the reads resolving: every link
 * keeps its place and its look, with its click unwired.
 */
export const ValidationPending: Story = {
  args: {
    validSkillIds: new Set(),
    validConversationIds: new Set(),
    isValidationPending: true,
  },
};
