import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { schedulesByIdRunsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

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
  reuseConversation: false,
  wakeConversationId: null,
  workflowName: null,
  sourceKey: null,
  userEnabled: null,
  disarmReason: null,
} as ScheduleDetailPanelProps["schedule"];

function seededClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    schedulesByIdRunsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, id: SCHEDULE.id },
    }),
    { runs: [] },
  );
  return client;
}

function withClient(client: QueryClient) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <div className="h-[640px] w-[420px]">
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
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
  decorators: [withClient(seededClient())],
};

export const PluginSourced: Story = {
  args: { schedule: { ...SCHEDULE, sourceKey: "plugin:github/digest" } },
  decorators: [withClient(seededClient())],
};

export const PastOneShot: Story = {
  args: { isPast: true },
  decorators: [withClient(seededClient())],
};
