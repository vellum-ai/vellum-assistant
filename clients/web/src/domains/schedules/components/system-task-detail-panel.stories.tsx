import type { Meta, StoryObj } from "@storybook/react-vite";

import { heartbeatRunsGetInfiniteQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { type SeedQueryCache, withQueryCache } from "@/lib/story-query-cache";

import { SystemTaskDetailPanel } from "./system-task-detail-panel";

const ASSISTANT_ID = "asst_story";

const noopMutation = {
  mutate: () => {},
  mutateAsync: async () => undefined,
  isPending: false,
} as const;

/**
 * `useSystemTasks`'s return type composes several TanStack Query results and
 * mutations. Storybook only exercises the header + static config display, so
 * the fetched-state fields are faked and the mutation-shaped fields are
 * stand-ins, hence the cast rather than a real hook return.
 */
function makeSystemTasks() {
  return {
    heartbeatConfig: {
      enabled: true,
      nextRunAt: Date.now() + 1_800_000,
      lastRunAt: Date.now() - 5_400_000,
      intervalMs: 3_600_000,
    },
    consolidationConfig: { enabled: true, nextRunAt: null, lastRunAt: null },
    retrospectiveConfig: { enabled: true, nextRunAt: null, lastRunAt: null },
    heartbeatUsage: { status: "error" },
    consolidationUsage: { status: "error" },
    retrospectiveUsage: { status: "error" },
    isLoading: false,
    hasError: false,
    isHeartbeatRunning: false,
    isConsolidationRunning: false,
    isHeartbeatLoading: false,
    isHeartbeatError: false,
    isConsolidationLoading: false,
    isConsolidationError: false,
    isRetrospectiveLoading: false,
    isRetrospectiveError: false,
    refetchHeartbeat: async () => {},
    refetchConsolidation: async () => {},
    refetchRetrospective: async () => {},
    runHeartbeatNow: () => {},
    runConsolidationNow: () => {},
    toggleHeartbeat: noopMutation,
    refetchAll: async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see doc comment above
  } as any;
}

const seedCache: SeedQueryCache = (client) => {
  const opts = {
    path: { assistant_id: ASSISTANT_ID },
    query: { limit: 20 },
  };
  client.setQueryData(heartbeatRunsGetInfiniteQueryKey(opts), {
    pages: [{ runs: [] }],
    pageParams: [{ path: opts.path, query: {} }],
  });
};

function withPanelBox(Story: () => React.ReactElement) {
  return (
    <div className="h-[640px] w-[420px]">
      <Story />
    </div>
  );
}

const meta: Meta<typeof SystemTaskDetailPanel> = {
  title: "Schedules/SystemTaskDetailPanel",
  component: SystemTaskDetailPanel,
  parameters: { layout: "centered" },
  args: {
    kind: "heartbeat",
    assistantId: ASSISTANT_ID,
    systemTasks: makeSystemTasks(),
    canOpenMemorySettings: true,
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof SystemTaskDetailPanel>;

export const Heartbeat: Story = {
  decorators: [withPanelBox, withQueryCache(seedCache)],
};

export const HeartbeatDisabled: Story = {
  args: {
    systemTasks: {
      ...makeSystemTasks(),
      heartbeatConfig: {
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        intervalMs: 3_600_000,
      },
    },
  },
  decorators: [withPanelBox, withQueryCache(seedCache)],
};
