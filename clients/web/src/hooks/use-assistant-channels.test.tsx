/**
 * Tests for which Slack state loads the channel's stored settings.
 *
 * The settings query answers a configuration question, and the readiness
 * snapshot carries two axes that used to be one: `setupStatus` says whether
 * setup finished, `health` says whether the socket is currently delivering.
 * Gating the query on delivery leaves the connection card mounted through an
 * outage with no thread mode to show, and the control renders a default in
 * that gap, so the card would report a setting the assistant is not using.
 *
 * The generated query factories are `mock.module`-replaced so each test counts
 * exactly when the settings query ran. The QueryClient uses `retry: false` so
 * a rejection lands on the first attempt.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ChannelReadinessSnapshot } from "@/types/channel-types";

const READINESS_KEY = ["channels-readiness"];
const SLACK_CONFIG_KEY = ["slack-channel-config"];

/** Readiness snapshots the daemon reports; each test seeds it. */
let snapshots: ChannelReadinessSnapshot[] = [];
/** How many times the Slack settings query actually ran. */
let slackConfigFetches = 0;

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  channelsReadinessGetOptions: () => ({
    queryKey: READINESS_KEY,
    queryFn: async () => ({ snapshots }),
  }),
  channelsReadinessGetQueryKey: () => READINESS_KEY,
  integrationsSlackChannelConfigGetOptions: () => ({
    queryKey: SLACK_CONFIG_KEY,
    queryFn: async () => {
      slackConfigFetches += 1;
      return { threadMode: "mention_only" };
    },
  }),
  integrationsSlackChannelConfigGetQueryKey: () => SLACK_CONFIG_KEY,
  integrationsSlackChannelConfigPatchMutation: () => ({
    mutationFn: async () => ({}),
  }),
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  integrationsSlackChannelConfigDelete: async () => ({}),
  integrationsTelegramConfigDelete: async () => ({}),
  integrationsTwilioCredentialsDelete: async () => ({}),
}));

mock.module("@/domains/channels/hooks/use-channel-trust-floors", () => ({
  useChannelTrustFloors: () => ({
    policies: undefined,
    savingKey: null,
    isLoading: false,
    isError: false,
    onChange: undefined,
  }),
}));

const idleMutation = {
  mutate: () => {},
  mutateAsync: async () => {},
  status: "idle" as const,
  error: null,
  isPending: false,
  variables: undefined,
};

mock.module("@/hooks/use-save-slack-config", () => ({
  useSaveSlackConfig: () => idleMutation,
}));
mock.module("@/hooks/use-save-telegram-config", () => ({
  useSaveTelegramConfig: () => idleMutation,
}));
mock.module("@/hooks/use-save-twilio-credentials", () => ({
  useSaveTwilioCredentials: () => idleMutation,
}));
mock.module("@/utils/slack-workspace-cache", () => ({
  removeSlackWorkspaceQueries: () => {},
}));

const { useAssistantChannels } = await import("./use-assistant-channels");

/** A Slack snapshot on the two axes the settings gate has to tell apart. */
function slackSnapshot(
  setupStatus: ChannelReadinessSnapshot["setupStatus"],
  health: ChannelReadinessSnapshot["health"],
): ChannelReadinessSnapshot {
  return {
    channel: "slack",
    setupStatus,
    ready: setupStatus === "ready" && health === "ok",
    health,
  };
}

function renderController() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useAssistantChannels({ assistantId: "assistant-123" }),
    { wrapper },
  );
}

describe("useAssistantChannels Slack settings gate", () => {
  beforeEach(() => {
    cleanup();
    slackConfigFetches = 0;
  });

  test("loads the stored thread mode while the socket is down", async () => {
    snapshots = [slackSnapshot("ready", "failing")];
    const { result } = renderController();

    await waitFor(() => expect(slackConfigFetches).toBe(1));
    await waitFor(() =>
      expect(result.current.slackThreadMode).toBe("mention_only"),
    );
    // The card is showing, so the control must not fall back to its default.
    expect(
      result.current.channels.find((ch) => ch.key === "slack")?.status,
    ).toBe("incomplete");
  });

  test("loads the stored thread mode when the socket is healthy", async () => {
    snapshots = [slackSnapshot("ready", "ok")];
    renderController();

    await waitFor(() => expect(slackConfigFetches).toBe(1));
  });

  test("does not ask for settings a channel has never had", async () => {
    snapshots = [slackSnapshot("not_configured", undefined)];
    const { result } = renderController();

    await waitFor(() =>
      expect(
        result.current.channels.find((ch) => ch.key === "slack")?.status,
      ).toBe("not_configured"),
    );
    expect(slackConfigFetches).toBe(0);
  });
});
