import type { Meta, StoryObj } from "@storybook/react-vite";

import type { UsageBucket } from "@/generated/api/types.gen";

import { BillingUsageChart } from "./billing-usage-chart";

const meta: Meta<typeof BillingUsageChart> = {
  title: "Settings/BillingUsageChart",
  component: BillingUsageChart,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    metric: {
      control: "inline-radio",
      options: ["spend", "events"],
    },
  },
  decorators: [
    (Story) => (
      <div style={{ width: "100%", maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BillingUsageChart>;

function makeBuckets(
  days: number,
  sources: { key: string; label: string; spendRange: [number, number]; eventRange: [number, number] }[],
): UsageBucket[] {
  const base = new Date("2025-06-04");
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(base);
    date.setDate(base.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    return {
      date: dateStr,
      groups: sources.map((s) => ({
        group_key: s.key,
        group_label: s.label,
        total_usd: (
          s.spendRange[0] +
          Math.random() * (s.spendRange[1] - s.spendRange[0])
        ).toFixed(4),
        event_count: Math.round(
          s.eventRange[0] +
            Math.random() * (s.eventRange[1] - s.eventRange[0]),
        ),
      })),
    };
  });
}

const TYPICAL_SOURCES = [
  { key: "runtime_proxy_api", label: "Runtime Proxy API", spendRange: [8, 26] as [number, number], eventRange: [200, 800] as [number, number] },
  { key: "oauth_proxy", label: "OAuth Proxy", spendRange: [2, 10] as [number, number], eventRange: [50, 300] as [number, number] },
];

export const Default: Story = {
  args: {
    buckets: makeBuckets(7, TYPICAL_SOURCES),
    metric: "spend",
  },
};

export const EventsMetric: Story = {
  args: {
    buckets: makeBuckets(7, TYPICAL_SOURCES),
    metric: "events",
  },
};

export const SubCentValues: Story = {
  args: {
    buckets: makeBuckets(7, [
      { key: "runtime_proxy_api", label: "Runtime Proxy API", spendRange: [0.001, 0.008], eventRange: [1, 5] },
      { key: "oauth_proxy", label: "OAuth Proxy", spendRange: [0.0005, 0.003], eventRange: [1, 3] },
    ]),
    metric: "spend",
  },
};

export const SingleSource: Story = {
  args: {
    buckets: makeBuckets(7, [
      { key: "runtime_proxy_api", label: "Runtime Proxy API", spendRange: [5, 30], eventRange: [100, 500] },
    ]),
    metric: "spend",
  },
};

export const ManySources: Story = {
  args: {
    buckets: makeBuckets(7, [
      { key: "runtime_proxy_api", label: "Runtime Proxy API", spendRange: [10, 25], eventRange: [200, 600] },
      { key: "oauth_proxy", label: "OAuth Proxy", spendRange: [3, 8], eventRange: [50, 200] },
      { key: "webhook_relay", label: "Webhook Relay", spendRange: [1, 5], eventRange: [20, 100] },
      { key: "scheduled_tasks", label: "Scheduled Tasks", spendRange: [2, 6], eventRange: [30, 150] },
    ]),
    metric: "spend",
  },
};

export const ThirtyDays: Story = {
  args: {
    buckets: makeBuckets(30, TYPICAL_SOURCES),
    metric: "spend",
  },
};

export const EmptyBuckets: Story = {
  args: {
    buckets: [],
    metric: "spend",
  },
};

export const WithClickHandler: Story = {
  args: {
    buckets: makeBuckets(7, TYPICAL_SOURCES),
    metric: "spend",
    onBarClick: (groupKey: string) => {
      console.log("Bar clicked:", groupKey);
    },
  },
};
