import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { type ReactNode } from "react";

import { useAssistantContext } from "@/domains/chat/assistant-context.js";
import { fetchConversationMessages } from "@/domains/chat/api/messages.js";
import { MessageInspectorView } from "@/domains/chat/inspector/components/message-inspector-view.js";

/**
 * `/assistant/inspect` page. Reads `?conversationKey=...&messageId=...`
 * from the query string and mounts the inspector view. When `messageId`
 * is omitted, resolves the latest assistant message for the given
 * conversation.
 */
export function InspectPage(): ReactNode {
  const [searchParams] = useSearchParams();
  const conversationKey = searchParams.get("conversationKey");
  const messageId = searchParams.get("messageId");

  if (!conversationKey) {
    return <MissingConversationKeyState />;
  }

  if (messageId) {
    return (
      <MessageInspectorView
        conversationKey={conversationKey}
        messageId={messageId}
      />
    );
  }

  return <ResolveLatestMessage conversationKey={conversationKey} />;
}

function ResolveLatestMessage({
  conversationKey,
}: {
  conversationKey: string;
}): ReactNode {
  const { assistantId } = useAssistantContext();

  const {
    data: latestAssistantMessageId,
    isLoading,
    isError,
  } = useQuery({
    queryKey: [
      "assistants",
      assistantId,
      "conversations",
      conversationKey,
      "latest-assistant-message-id",
    ] as const,
    queryFn: async (): Promise<string | null> => {
      if (!assistantId) return null;
      const messages = await fetchConversationMessages(
        assistantId,
        conversationKey,
      );
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i]!;
        if (msg.role !== "assistant") continue;
        const id = msg.daemonMessageId ?? msg.id;
        if (id) return id;
      }
      return null;
    },
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return <CenteredMessage tone="muted">Loading…</CenteredMessage>;
  }
  if (isError) {
    return (
      <CenteredMessage tone="muted">
        Failed to load conversation messages.
      </CenteredMessage>
    );
  }
  if (!latestAssistantMessageId) {
    return <NoAssistantMessageState />;
  }

  return (
    <MessageInspectorView
      conversationKey={conversationKey}
      messageId={latestAssistantMessageId}
    />
  );
}

function MissingConversationKeyState(): ReactNode {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Missing inspector parameters
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Open the inspector from a conversation&rsquo;s overflow menu — direct
        navigation requires a <code>conversationKey</code>.
      </p>
    </div>
  );
}

function NoAssistantMessageState(): ReactNode {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Nothing to inspect yet
      </h2>
      <p
        className="max-w-md text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        This conversation has no assistant messages — the inspector needs at
        least one assistant turn to show LLM context.
      </p>
    </div>
  );
}

function CenteredMessage({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "muted" | "default";
}): ReactNode {
  const color =
    tone === "muted" ? "var(--content-tertiary)" : "var(--content-secondary)";
  return (
    <div
      className="flex h-full w-full items-center justify-center p-8 text-label-default"
      style={{ color }}
    >
      {children}
    </div>
  );
}
