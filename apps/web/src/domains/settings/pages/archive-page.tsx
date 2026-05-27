import { Archive, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
  type Conversation,
  listConversations,
} from "@/lib/conversations-api";
import { conversationsByIdUnarchivePost } from "@/generated/daemon/sdk.gen";
import { reportError } from "@/lib/errors/report";

function formatConversationDate(timestamp: number | undefined): string {
  if (timestamp == null) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function EmptyState() {
  return (
    <Card>
      <div className="flex min-h-[400px] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
          <Archive className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]" />
        </div>
        <h2 className="mt-4 text-title-small text-[var(--content-default)]">
          No archived conversations
        </h2>
        <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
          Conversations you archive will appear here.
        </p>
      </div>
    </Card>
  );
}

function ArchivedConversationRow({
  conversation,
  isFirst,
  onUnarchive,
  isPending,
}: {
  conversation: Conversation;
  isFirst: boolean;
  onUnarchive: () => void;
  isPending: boolean;
}) {
  const dateText = formatConversationDate(conversation.createdAt);
  const source = conversation.source ?? "vellum-assistant";
  const meta = [dateText, source].filter(Boolean).join(" · ");
  const title =
    conversation.title && conversation.title.trim().length > 0
      ? conversation.title
      : "Untitled conversation";

  return (
    <div
      className={`flex items-center gap-3 py-3 ${
        isFirst ? "" : "border-t border-[var(--border-base)]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-medium-default text-[var(--content-default)]">
          {title}
        </div>
        <p className="mt-0.5 truncate text-body-small-default text-[var(--content-tertiary)]">
          {meta}
        </p>
      </div>
      <Button
        variant="outlined"
        onClick={onUnarchive}
        disabled={isPending}
        className="shrink-0"
      >
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Unarchiving
          </>
        ) : (
          "Unarchive"
        )}
      </Button>
    </div>
  );
}

export function ArchivePage() {
  const { data: assistantList, isLoading: isAssistantLoading } = useQuery(
    assistantsListOptions(),
  );
  const assistantId = assistantList?.results?.[0]?.id;

  const [conversations, setConversations] = useState<Conversation[] | null>(
    null,
  );
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [pendingUnarchiveId, setPendingUnarchiveId] = useState<string | null>(
    null,
  );

  const loadConversations = useCallback(async (id: string) => {
    setIsLoadingConversations(true);
    try {
      const all = await listConversations(id);
      setConversations(all);
    } catch (error) {
      reportError(error, {
        context: "archive_settings_list_conversations",
        userMessage: "Failed to load archived conversations.",
      });
      setConversations([]);
    } finally {
      setIsLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    if (!assistantId) return;
    void loadConversations(assistantId);
  }, [assistantId, loadConversations]);

  const archived = useMemo(() => {
    if (!conversations) return [];
    return conversations
      .filter((c) => c.archivedAt != null)
      .sort(
        (a, b) =>
          new Date(b.archivedAt ?? 0).getTime() -
          new Date(a.archivedAt ?? 0).getTime(),
      );
  }, [conversations]);

  const handleUnarchive = useCallback(
    async (conversationId: string) => {
      if (!assistantId) return;
      setPendingUnarchiveId(conversationId);
      try {
        await conversationsByIdUnarchivePost({
          path: { assistant_id: assistantId, id: conversationId },
          throwOnError: true,
        });
        setConversations((prev) => {
          if (!prev) return prev;
          return prev.map((c) =>
            c.conversationId === conversationId
              ? { ...c, archivedAt: undefined }
              : c,
          );
        });
      } catch (error) {
        reportError(error, {
          context: "archive_settings_unarchive_conversation",
          userMessage: "Failed to unarchive conversation.",
        });
      } finally {
        setPendingUnarchiveId(null);
      }
    },
    [assistantId],
  );

  const isLoading =
    isAssistantLoading ||
    isLoadingConversations ||
    (assistantId != null && conversations === null);

  if (isLoading) {
    return (
      <div className="max-w-[940px]">
        <div className="flex min-h-[400px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-disabled)]" />
        </div>
      </div>
    );
  }

  if (archived.length === 0) {
    return (
      <div className="max-w-[940px]">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="max-w-[940px]">
      <Card noPadding className="px-4">
        {archived.map((conversation, index) => (
          <ArchivedConversationRow
            key={conversation.conversationId}
            conversation={conversation}
            isFirst={index === 0}
            onUnarchive={() => {
              void handleUnarchive(conversation.conversationId);
            }}
            isPending={pendingUnarchiveId === conversation.conversationId}
          />
        ))}
      </Card>
    </div>
  );
}
