
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Suspense, type ReactNode } from "react";

import { MessageInspectorView } from "@/components/app/assistant/message-inspector/message-inspector-view.js";
import { AssistantShell as Layout } from "@/components/shell/assistant-shell.js";
import { fetchConversationMessages } from "@/domains/chat/lib/api.js";
import { useResolvedAssistantId } from "@/lib/logs/useResolvedAssistantId.js";

/**
 * Conversation LLM context inspector. Web counterpart of macOS's
 * `MessageInspectorView`
 * (`clients/macos/vellum-assistant/Features/Chat/MessageInspectorView.swift`).
 *
 * Reads `?conversationKey=...&messageId=...` from the query string and
 * mounts the inspector view, which fetches its data via the daemon's
 * `GET /v1/messages/{messageId}/llm-context` route — proxied through
 * the platform's `RuntimeProxyWildcardView` at
 * `/v1/assistants/{assistantId}/messages/{messageId}/llm-context/`.
 *
 * `messageId` is optional. When omitted (e.g. clicking Inspect on a
 * non-active conversation, where the page client has no in-memory
 * transcript to derive an id from), we resolve the latest assistant
 * message for `conversationKey` and inspect that.
 */
function InspectPageInner(): ReactNode {
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

interface ResolveLatestMessageProps {
  conversationKey: string;
}

function ResolveLatestMessage({
  conversationKey,
}: ResolveLatestMessageProps): ReactNode {
  const { assistantId, isLoading: isLoadingAssistant } =
    useResolvedAssistantId();

  const {
    data: latestAssistantMessageId,
    isLoading: isLoadingMessages,
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
      // Walk newest → oldest looking for the most recent assistant
      // message with a usable id. Mirrors the active-conversation path
      // in AssistantPageClient.handleInspectConversation.
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

  if (isLoadingAssistant || isLoadingMessages) {
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

interface CenteredMessageProps {
  children: ReactNode;
  tone?: "muted" | "default";
}

function CenteredMessage({
  children,
  tone = "default",
}: CenteredMessageProps): ReactNode {
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

export default function InspectPage(): ReactNode {
  return (
    <Layout>
      <Suspense fallback={null}>
        <InspectPageInner />
      </Suspense>
    </Layout>
  );
}
