/**
 * Tests for the narrow Slack-configured read.
 *
 * `useAssistantChannels` answers the same question as one field of a much
 * larger controller, and callers that only gate an outbound Slack action pay
 * for its readiness poll, config queries, and mutations. These pin what makes
 * the narrow read a safe substitute: it derives Slack's configured state from
 * `setupStatus` exactly as the controller does.
 *
 * The generated query factory is `mock.module`-replaced so a test can seed the
 * snapshots the daemon reports.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ChannelReadinessSnapshot } from "@/types/channel-types";

const READINESS_KEY = ["channels-readiness"];

let snapshots: readonly ChannelReadinessSnapshot[] = [];

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  channelsReadinessGetOptions: () => ({
    queryKey: READINESS_KEY,
    queryFn: async () => ({ snapshots }),
  }),
}));

const { useSlackConfigured } = await import("@/hooks/use-slack-configured");

function snapshot(
  channel: string,
  setupStatus: string,
): ChannelReadinessSnapshot {
  return { channel, setupStatus } as unknown as ChannelReadinessSnapshot;
}

/**
 * Held outside the wrapper so a test can read the readiness query's own
 * state: the hook answers `false` before the first response lands, so a
 * negative case that asserts the answer alone passes on the first render,
 * whatever the hook derives.
 */
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  cleanup();
  snapshots = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

test.each([
  {
    state: "Slack finished setup",
    seed: [snapshot("slack", "ready")],
    configured: true,
  },
  {
    state: "Slack got part way",
    seed: [snapshot("slack", "incomplete")],
    configured: false,
  },
  {
    state: "only another channel is ready",
    seed: [snapshot("telegram", "ready")],
    configured: false,
  },
  { state: "the daemon reports nothing", seed: [], configured: false },
])("reports $configured when $state", async ({ seed, configured }) => {
  snapshots = seed;

  const { result } = renderHook(() => useSlackConfigured("asst-1"), {
    wrapper,
  });

  await waitFor(() => {
    expect(client.getQueryState(READINESS_KEY)?.status).toBe("success");
    expect(result.current).toBe(configured);
  });
});

test("reports false before the first readiness answer lands", () => {
  snapshots = [snapshot("slack", "ready")];

  const { result } = renderHook(() => useSlackConfigured("asst-1"), {
    wrapper,
  });

  expect(result.current).toBe(false);
});
