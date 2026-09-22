import type { Meta, StoryObj } from "@storybook/react-vite";

import { schedulesByIdRunsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { type SeedQueryCache, withQueryCache } from "@/lib/story-query-cache";

import {
  ScheduleDetailPanel,
  type ScheduleDetailPanelProps,
} from "./schedule-detail-panel";

const ASSISTANT_ID = "asst_story";

const SCHEDULE: ScheduleDetailPanelProps["schedule"] = {
  id: "sched-1",
  name: "Morning news digest",
  enabled: true,
  syntax: "cron",
  expression: "0 8 * * *",
  cronExpression: "0 8 * * *",
  timezone: "America/New_York",
  message: "Summarize today's top headlines",
  script: null,
  nextRunAt: Date.now() + 3600_000,
  lastRunAt: Date.now() - 82_800_000,
  lastStatus: "completed",
  retryCount: 0,
  maxRetries: 3,
  retryBackoffMs: 1000,
  timeoutMs: null,
  inferenceProfile: "balanced",
  groupId: null,
  createdFromConversationId: null,
  createdFromConversationExists: false,
  createdFromConversationArchivedAt: null,
  description: "Sends a digest of the day's top news every morning.",
  cadenceDescription: "Every day at 8:00 AM",
  mode: "notify",
  status: "active",
  routingIntent: "single_channel",
  quiet: false,
  reuseConversation: false,
  wakeConversationId: null,
  workflowName: null,
  sourceKey: null,
  userEnabled: null,
  disarmReason: null,
} as ScheduleDetailPanelProps["schedule"];

const seedCache: SeedQueryCache = (client) => {
  client.setQueryData(
    schedulesByIdRunsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, id: SCHEDULE.id },
    }),
    { runs: [] },
  );
};

function withPanelBox(Story: () => React.ReactElement) {
  return (
    <div className="h-[640px] w-[420px]">
      <Story />
    </div>
  );
}

const meta: Meta<typeof ScheduleDetailPanel> = {
  title: "Schedules/ScheduleDetailPanel",
  component: ScheduleDetailPanel,
  parameters: { layout: "centered" },
  args: {
    schedule: SCHEDULE,
    assistantId: ASSISTANT_ID,
    usage: { status: "error" },
    onClose: () => {},
    onDeleted: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ScheduleDetailPanel>;

export const Active: Story = {
  decorators: [withPanelBox, withQueryCache(seedCache)],
};

export const PluginSourced: Story = {
  args: { schedule: { ...SCHEDULE, sourceKey: "plugin:github/digest" } },
  decorators: [withPanelBox, withQueryCache(seedCache)],
};

export const PastOneShot: Story = {
  args: { isPast: true },
  decorators: [withPanelBox, withQueryCache(seedCache)],
};

export const PendingOneShot: Story = {
  args: {
    schedule: {
      ...SCHEDULE,
      name: "Add members and partners to phone system",
      description: "Remind me to add members and partners to the phone system.",
      isOneShot: true,
      expression: null,
      cronExpression: null,
      cadenceDescription: "",
      lastRunAt: null,
      lastStatus: null,
    },
  },
  decorators: [withPanelBox, withQueryCache(seedCache)],
};
