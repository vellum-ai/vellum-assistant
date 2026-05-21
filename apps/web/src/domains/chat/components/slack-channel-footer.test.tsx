import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { client } from "@/domains/chat/api/client.js";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer.js";

describe("SlackChannelFooter lazy channel name resolution", () => {
  const originalPost = client.post;
  let postCalls: Array<Parameters<typeof client.post>[0]> = [];
  let nextResolveResponse: {
    data: unknown;
    error: unknown;
    response: Response;
  };

  beforeEach(() => {
    postCalls = [];
    nextResolveResponse = {
      data: {
        channelId: "C0123ABCDEF",
        channelName: "product",
        cached: false,
        resolved: true,
      },
      error: null,
      response: new Response(null, { status: 200 }),
    };
    client.post = mock(async (options: Parameters<typeof client.post>[0]) => {
      postCalls.push(options);
      return nextResolveResponse;
    }) as typeof client.post;
  });

  afterEach(() => {
    client.post = originalPost;
    cleanup();
  });

  test("resolves an ID-only Slack channel fallback", async () => {
    render(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-lazy-resolve",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C0123ABCDEF",
          },
        }}
      />,
    );

    expect(screen.queryByText("C0123ABCDEF")).not.toBeNull();

    await waitFor(() => {
      expect(screen.queryByText("product")).not.toBeNull();
    });

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toMatchObject({
      url: "/v1/assistants/{assistant_id}/conversations/{conversationId}/slack-channel/resolve",
      path: {
        assistant_id: "assistant-1",
        conversationId: "conv-lazy-resolve",
      },
      body: {},
      throwOnError: false,
    });
  });

  test("does not resolve when the binding already has a friendly name", async () => {
    render(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-friendly-name",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C0123ABCDEF",
            externalChatName: "Product",
          },
        }}
      />,
    );

    expect(screen.queryByText("Product")).not.toBeNull();
    await Promise.resolve();
    expect(postCalls).toHaveLength(0);
  });

  test("does not resolve Slack direct-message channels", async () => {
    render(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-direct-message",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "D0123ABCDEF",
          },
        }}
      />,
    );

    expect(screen.queryByText("D0123ABCDEF")).not.toBeNull();
    await Promise.resolve();
    expect(postCalls).toHaveLength(0);
  });

  test("keeps the channel ID fallback when resolution is unavailable", async () => {
    nextResolveResponse = {
      data: {
        channelId: "C9876ZYXWVU",
        cached: false,
        resolved: false,
      },
      error: null,
      response: new Response(null, { status: 200 }),
    };

    render(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-unresolved",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C9876ZYXWVU",
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(screen.queryByText("C9876ZYXWVU")).not.toBeNull();
  });

  test("prefers a refreshed binding name over a cached lazy resolution", async () => {
    const { rerender } = render(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-refreshed-name",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C0123ABCDEF",
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("product")).not.toBeNull();
    });

    rerender(
      <SlackChannelFooter
        assistantId="assistant-1"
        conversation={{
          conversationKey: "conv-refreshed-name",
          originChannel: "slack",
          channelBinding: {
            sourceChannel: "slack",
            externalChatId: "C0123ABCDEF",
            externalChatName: "renamed-product",
          },
        }}
      />,
    );

    expect(screen.queryByText("renamed-product")).not.toBeNull();
    expect(screen.queryByText("product")).toBeNull();
  });

  test("deduplicates in-flight resolution for repeated renders", async () => {
    let resolvePost:
      | ((value: typeof nextResolveResponse) => void)
      | undefined;
    client.post = mock(async (options: Parameters<typeof client.post>[0]) => {
      postCalls.push(options);
      return await new Promise<typeof nextResolveResponse>((resolve) => {
        resolvePost = resolve;
      });
    }) as typeof client.post;

    render(
      <>
        <SlackChannelFooter
          assistantId="assistant-1"
          conversation={{
            conversationKey: "conv-deduped",
            originChannel: "slack",
            channelBinding: {
              sourceChannel: "slack",
              externalChatId: "CDEDUPED123",
            },
          }}
        />
        <SlackChannelFooter
          assistantId="assistant-1"
          conversation={{
            conversationKey: "conv-deduped",
            originChannel: "slack",
            channelBinding: {
              sourceChannel: "slack",
              externalChatId: "CDEDUPED123",
            },
          }}
        />
      </>,
    );

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });

    resolvePost?.({
      data: {
        channelId: "CDEDUPED123",
        channelName: "shared-channel",
        cached: false,
        resolved: true,
      },
      error: null,
      response: new Response(null, { status: 200 }),
    });

    await waitFor(() => {
      expect(screen.queryAllByText("shared-channel")).toHaveLength(2);
    });
  });
});
