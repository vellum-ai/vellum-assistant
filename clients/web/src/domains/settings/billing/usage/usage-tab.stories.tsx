/**
 * The Usage tab of the billing page: a totals strip, the trend chart, and the
 * breakdown table that lists one row per group with a right-aligned cost and
 * three optional columns (share of total, tokens, turns) behind toggles. The
 * tab reads everything it shows from the daemon with time-windowed query keys,
 * so `beforeEach` answers those reads from fixtures through the generated
 * client's `fetch`; the grouping comes from the URL, as it does in the app.
 * The stories cover the default per-task grouping, the same table with every
 * optional column on, the per-conversation grouping whose rows link out, and
 * a period with no usage.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { UsageTab } from "@/domains/settings/billing/usage/usage-tab";
import { client } from "@/generated/daemon/client.gen";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";
import type {
  ConfigGetResponse,
  ConfigLlmCallsitesGetResponse,
  SchedulesGetResponse,
  UsageBreakdownGetResponse,
  UsageDailyGetResponse,
  UsageSeriesGetResponse,
  UsageTotalsGetResponse,
} from "@/generated/daemon/types.gen";
import { toDaemonGroupBy } from "@/utils/llm-dimension";
import { routes } from "@/utils/routes";

const ASSISTANT_IDS = {
  active: "story-assistant",
  idle: "story-assistant-idle",
} as const;

type UsageGroupRow = UsageBreakdownGetResponse["breakdown"][number];
type UsageSeriesBucket = UsageSeriesGetResponse["buckets"][number];

/** The call-site catalog the task grouping resolves its row labels from. */
const CALL_SITES: ConfigLlmCallsitesGetResponse = {
  domains: [
    { id: "chat", displayName: "Chat" },
    { id: "memory", displayName: "Memory" },
    { id: "schedules", displayName: "Schedules" },
  ],
  callSites: [
    {
      id: "chat.turn",
      displayName: "Chat replies",
      description: "The model call behind each reply in a conversation.",
      domain: "chat",
    },
    {
      id: "chat.title",
      displayName: "Conversation titles",
      description: "Names a conversation after its first exchange.",
      domain: "chat",
    },
    {
      id: "memory.extract",
      displayName: "Memory extraction",
      description: "Pulls durable facts out of a finished conversation.",
      domain: "memory",
    },
    {
      id: "schedules.run",
      displayName: "Scheduled runs",
      description: "Runs a schedule's message when it fires.",
      domain: "schedules",
    },
  ],
};

const TASK_ROWS: UsageGroupRow[] = [
  {
    group: "chat.turn",
    groupId: "chat.turn",
    groupKey: "chat.turn",
    totalInputTokens: 1_842_300,
    totalOutputTokens: 236_410,
    totalCacheCreationTokens: 412_000,
    totalCacheReadTokens: 3_910_500,
    totalEstimatedCostUsd: 4.8231,
    eventCount: 312,
    turnCount: 148,
  },
  {
    group: "schedules.run",
    groupId: "schedules.run",
    groupKey: "schedules.run",
    totalInputTokens: 640_200,
    totalOutputTokens: 88_900,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 210_000,
    totalEstimatedCostUsd: 1.1045,
    eventCount: 56,
    turnCount: 28,
  },
  {
    group: "memory.extract",
    groupId: "memory.extract",
    groupKey: "memory.extract",
    totalInputTokens: 205_800,
    totalOutputTokens: 14_200,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: 0.312,
    eventCount: 41,
    turnCount: null,
  },
  {
    group: "chat.title",
    groupId: "chat.title",
    groupKey: "chat.title",
    totalInputTokens: 38_400,
    totalOutputTokens: 2_100,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: 0.0842,
    eventCount: 37,
    turnCount: null,
  },
];

const CONVERSATION_ROWS: UsageGroupRow[] = [
  {
    group: "Planning the Lisbon trip",
    groupId: "conv-lisbon",
    groupKey: null,
    totalInputTokens: 980_100,
    totalOutputTokens: 121_300,
    totalCacheCreationTokens: 212_000,
    totalCacheReadTokens: 2_100_000,
    totalEstimatedCostUsd: 2.6104,
    eventCount: 164,
    turnCount: 79,
  },
  {
    group: "Kitchen remodel budget",
    groupId: "conv-kitchen",
    groupKey: null,
    totalInputTokens: 612_800,
    totalOutputTokens: 74_900,
    totalCacheCreationTokens: 140_000,
    totalCacheReadTokens: 1_290_500,
    totalEstimatedCostUsd: 1.7322,
    eventCount: 98,
    turnCount: 46,
  },
  {
    group: "Weekly meal plan",
    groupId: "conv-meals",
    groupKey: null,
    totalInputTokens: 249_400,
    totalOutputTokens: 40_210,
    totalCacheCreationTokens: 60_000,
    totalCacheReadTokens: 520_000,
    totalEstimatedCostUsd: 0.4805,
    eventCount: 50,
    turnCount: 23,
  },
  {
    group: "Other",
    groupId: null,
    groupKey: null,
    totalInputTokens: 884_400,
    totalOutputTokens: 105_200,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 210_000,
    totalEstimatedCostUsd: 1.5007,
    eventCount: 134,
    turnCount: null,
  },
];

const ACTIVE_TOTALS: UsageTotalsGetResponse = {
  totalInputTokens: 2_726_700,
  totalOutputTokens: 341_610,
  totalCacheCreationTokens: 412_000,
  totalCacheReadTokens: 4_120_500,
  totalEstimatedCostUsd: 6.3238,
  eventCount: 446,
  pricedEventCount: 446,
  unpricedEventCount: 0,
};

const IDLE_TOTALS: UsageTotalsGetResponse = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  totalEstimatedCostUsd: 0,
  eventCount: 0,
  pricedEventCount: 0,
  unpricedEventCount: 0,
};

/** One week of daily cost per call site, oldest day first. */
const DAILY_COST_BY_CALL_SITE: Record<string, number[]> = {
  "chat.turn": [0.42, 0.88, 0.61, 1.12, 0.74, 0.39, 0.66],
  "schedules.run": [0.16, 0.16, 0.15, 0.16, 0.16, 0.15, 0.16],
  "memory.extract": [0.03, 0.06, 0.04, 0.08, 0.05, 0.02, 0.04],
  "chat.title": [0.01, 0.02, 0.01, 0.02, 0.01, 0.0, 0.01],
};

/** Daily buckets as the daemon emits them: the day is the id, labelled short. */
const WEEK: Array<{ date: string; displayLabel: string }> = [
  { date: "2026-09-11", displayLabel: "Sep 11" },
  { date: "2026-09-12", displayLabel: "Sep 12" },
  { date: "2026-09-13", displayLabel: "Sep 13" },
  { date: "2026-09-14", displayLabel: "Sep 14" },
  { date: "2026-09-15", displayLabel: "Sep 15" },
  { date: "2026-09-16", displayLabel: "Sep 16" },
  { date: "2026-09-17", displayLabel: "Sep 17" },
];

/** Tokens per dollar the fixture assumes, so token counts track the costs. */
const TOKENS_PER_USD = 250_000;

const ACTIVE_SERIES: UsageSeriesGetResponse = {
  buckets: WEEK.map(({ date, displayLabel }, day): UsageSeriesBucket => {
    const groups = Object.fromEntries(
      Object.entries(DAILY_COST_BY_CALL_SITE).map(([callSite, costs]) => {
        const cost = costs[day] ?? 0;
        const tokens = Math.round(cost * TOKENS_PER_USD);
        return [
          `value:${callSite}`,
          {
            group: callSite,
            groupKey: callSite,
            totalInputTokens: Math.round(tokens * 0.88),
            totalOutputTokens: Math.round(tokens * 0.12),
            totalEstimatedCostUsd: cost,
            eventCount: Math.max(1, Math.round(tokens / 6_000)),
          },
        ];
      }),
    );
    const totalCost = Object.values(groups).reduce(
      (sum, group) => sum + group.totalEstimatedCostUsd,
      0,
    );
    const totalTokens = Math.round(totalCost * TOKENS_PER_USD);
    return {
      bucketId: date,
      date,
      displayLabel,
      totalInputTokens: Math.round(totalTokens * 0.88),
      totalOutputTokens: Math.round(totalTokens * 0.12),
      totalEstimatedCostUsd: totalCost,
      eventCount: Object.values(groups).reduce(
        (sum, group) => sum + group.eventCount,
        0,
      ),
      groups,
    };
  }),
};

/** The ungrouped week, which the conversation grouping's chart falls back to. */
const ACTIVE_DAILY: UsageDailyGetResponse = {
  buckets: ACTIVE_SERIES.buckets.map(
    ({ groups: _groups, ...bucket }) => bucket,
  ),
};

interface UsageFixture {
  totals: UsageTotalsGetResponse;
  /** Breakdown rows keyed by the wire `groupBy` the tab requests. */
  breakdown: Partial<Record<string, UsageGroupRow[]>>;
  series: UsageSeriesGetResponse;
  daily: UsageDailyGetResponse;
}

const ACTIVE_USAGE: UsageFixture = {
  totals: ACTIVE_TOTALS,
  breakdown: {
    [toDaemonGroupBy("task")]: TASK_ROWS,
    conversation: CONVERSATION_ROWS,
  },
  series: ACTIVE_SERIES,
  daily: ACTIVE_DAILY,
};

const IDLE_USAGE: UsageFixture = {
  totals: IDLE_TOTALS,
  breakdown: {},
  series: { buckets: [] },
  daily: { buckets: [] },
};

const NO_SCHEDULES: SchedulesGetResponse = { schedules: [] };
const EMPTY_CONFIG: ConfigGetResponse = {};

/**
 * Answers the daemon reads the tab makes for whichever assistant the request
 * names. Groupings the fixture has no rows for answer an empty breakdown, so
 * switching the picker in the story lands on the empty state, not an error.
 */
async function usageFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const fixture = pathname.startsWith(`/v1/assistants/${ASSISTANT_IDS.idle}/`)
    ? IDLE_USAGE
    : ACTIVE_USAGE;
  if (pathname.endsWith("/usage/totals")) {
    return Response.json(fixture.totals satisfies UsageTotalsGetResponse);
  }
  if (pathname.endsWith("/usage/breakdown")) {
    const groupBy = url.searchParams.get("groupBy") ?? "";
    return Response.json({
      breakdown: fixture.breakdown[groupBy] ?? [],
    } satisfies UsageBreakdownGetResponse);
  }
  if (pathname.endsWith("/usage/series")) {
    return Response.json(fixture.series satisfies UsageSeriesGetResponse);
  }
  if (pathname.endsWith("/usage/daily")) {
    return Response.json(fixture.daily satisfies UsageDailyGetResponse);
  }
  if (pathname.endsWith("/config/llm/call-sites")) {
    return Response.json(CALL_SITES satisfies ConfigLlmCallsitesGetResponse);
  }
  if (pathname.endsWith("/config")) {
    return Response.json(EMPTY_CONFIG satisfies ConfigGetResponse);
  }
  if (pathname.endsWith("/schedules")) {
    return Response.json(NO_SCHEDULES satisfies SchedulesGetResponse);
  }
  return fixtureNotFound();
}

const meta = {
  title: "Settings/Billing/UsageTab",
  component: UsageTab,
  parameters: {
    layout: "padded",
    router: { initialEntries: [routes.settings.usage] },
  },
  args: {
    assistantId: ASSISTANT_IDS.active,
  },
  argTypes: {
    assistantId: {
      control: "radio",
      options: Object.values(ASSISTANT_IDS),
    },
  },
  beforeEach: () => stubClientFetch(client, usageFetch),
  decorators: [
    (Story) => (
      <div className="w-[880px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UsageTab>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default view: the last seven days grouped by task, with the call-site
 * catalog turning ids into display names and the cost column on the right.
 */
export const ByTask: Story = {};

/**
 * Every optional column switched on: share of total and turns join the cost
 * on the right, tokens sit beside the group name, and a row without a turn
 * count shows a dash.
 */
export const AllColumns: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["% of total", "Tokens", "Turns"]) {
      await userEvent.click(await canvas.findByRole("button", { name }));
    }
  },
};

/**
 * Grouped by conversation: each named row links to its conversation, the
 * "Other" row has no conversation to link to, and the chart draws the
 * ungrouped daily totals.
 */
export const ByConversation: Story = {
  parameters: {
    router: {
      initialEntries: [`${routes.settings.usage}?groupBy=conversation`],
    },
  },
};

/** An assistant that made no model calls in the period. */
export const NoUsage: Story = {
  args: {
    assistantId: ASSISTANT_IDS.idle,
  },
};
