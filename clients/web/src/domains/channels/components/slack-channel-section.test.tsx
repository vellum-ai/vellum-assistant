/**
 * Tests for `SlackChannelSection`'s reaction to the override-fetch state, the
 * axis LUM-2732 is about: a failed fetch must leave the access controls visible
 * but disabled *and* say why, while a gateway that can't serve them at all
 * still degrades to the read-only channel list.
 *
 * `useChannelPermissionOverrides` is `mock.module`-replaced with a seeded
 * controller. The hook's own error classification is covered in
 * `hooks/use-channel-permission-overrides.test.tsx`; what matters here is what
 * the section renders for each controller shape. The channel list and global
 * thresholds are mocked to resolve from fixtures so no query hits the network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import type { SlackChannel } from "@/domains/channels/slack-channels-query";
import type { ChannelPermissionOverridesController } from "@/domains/channels/hooks/use-channel-permission-overrides";

const CHANNELS: SlackChannel[] = [
  {
    id: "C1",
    name: "general",
    type: "channel",
    isPrivate: false,
    isMember: true,
    memberCount: 12,
    topic: null,
    imageUrl: null,
  },
];

/** The controller the mocked hook returns; each test seeds it. */
let controller: ChannelPermissionOverridesController;

mock.module(
  "@/domains/channels/hooks/use-channel-permission-overrides",
  () => ({
    useChannelPermissionOverrides: () => controller,
  }),
);

mock.module("@/domains/channels/slack-channels-query", () => ({
  memberSlackChannelsOptions: () => ({
    queryKey: ["slack-channels"],
    queryFn: async () => ({ channels: CHANNELS }),
  }),
}));

mock.module("@/lib/threshold-api", () => ({
  getGlobalThresholds: async () => ({ interactive: "low" }),
}));

const { SlackChannelSection } =
  await import("@/domains/channels/components/slack-channel-section");

/** A healthy controller: cells loaded, every handler wired. */
function healthyController(
  overrides: Partial<ChannelPermissionOverridesController> = {},
): ChannelPermissionOverridesController {
  return {
    supported: true,
    tierOverrides: {},
    defaultCellTier: null,
    bucketTiers: { channels: undefined, dm: undefined },
    pendingChannelIds: new Set(),
    pendingBuckets: new Set(),
    isLoading: false,
    isError: false,
    onTierChange: () => {},
    onTierReset: () => {},
    onBucketChange: () => {},
    onBucketReset: () => {},
    ...overrides,
  };
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  // The tier legend links to the Risk Tolerance page, so the tree needs a router.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <SlackChannelSection
      assistantId="assistant-123"
      assistantDisplayName="Vex"
      slackHandle="@vex"
    />,
    { wrapper },
  );
}

/**
 * The two always-visible default-access pickers. The per-channel row pickers
 * sit inside a collapsed section, so they aren't in the DOM on first render.
 */
function defaultPickers(): HTMLElement[] {
  return [
    screen.queryByRole("combobox", {
      name: "Default Assistant Access for Channels",
    }),
    screen.queryByRole("combobox", {
      name: "Default Assistant Access for Direct messages",
    }),
  ].filter((el): el is HTMLElement => el !== null);
}

const ERROR_COPY = /Couldn’t load access settings/;

beforeEach(() => {
  controller = healthyController();
});

afterEach(() => {
  cleanup();
});

describe("SlackChannelSection", () => {
  test("disables both default pickers when the override fetch failed", () => {
    controller = healthyController({
      isError: true,
      // A failed fetch leaves the stored cells unknown.
      tierOverrides: undefined,
      bucketTiers: undefined,
    });
    renderSection();

    const pickers = defaultPickers();
    expect(pickers.length).toBe(2);
    for (const picker of pickers) {
      expect((picker as HTMLButtonElement).disabled).toBe(true);
      expect(picker.getAttribute("aria-disabled")).toBe("true");
    }
  });

  test("explains why the pickers are disabled when the fetch failed", () => {
    controller = healthyController({ isError: true });
    renderSection();

    expect(screen.getByText(ERROR_COPY)).toBeTruthy();
  });

  test("leaves the pickers enabled and unexplained when the fetch succeeded", () => {
    renderSection();

    const pickers = defaultPickers();
    expect(pickers.length).toBe(2);
    for (const picker of pickers) {
      expect((picker as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
  });

  test("holds the pickers disabled while the cells are still loading", () => {
    controller = healthyController({
      isLoading: true,
      tierOverrides: undefined,
      bucketTiers: undefined,
    });
    renderSection();

    for (const picker of defaultPickers()) {
      expect((picker as HTMLButtonElement).disabled).toBe(true);
    }
    // Loading is not a failure, so no error copy.
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
  });

  test("degrades to the read-only list when access controls are unsupported", () => {
    controller = {
      supported: false,
      tierOverrides: undefined,
      defaultCellTier: undefined,
      bucketTiers: undefined,
      pendingChannelIds: new Set(),
      pendingBuckets: new Set(),
      isLoading: false,
      isError: false,
      onTierChange: undefined,
      onTierReset: undefined,
      onBucketChange: undefined,
      onBucketReset: undefined,
    };
    renderSection();

    // No access controls at all, and no error state, since nothing failed.
    expect(defaultPickers().length).toBe(0);
    expect(screen.queryByText(ERROR_COPY)).toBeNull();
    // The presence list still renders.
    expect(document.body.textContent).toContain("/invite @vex");
  });
});
