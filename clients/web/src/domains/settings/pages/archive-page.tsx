import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { conversationsByIdUnarchivePost } from "@/generated/daemon/sdk.gen";
import { useArchivedConversationListQuery } from "@/hooks/conversation-queries";
import { captureError } from "@/lib/sentry/capture-error";
import type { Conversation } from "@/types/conversation-types";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import { toast } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

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
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  const {
    conversations: archived,
    isLoading: isLoadingConversations,
    isError,
    refetch,
  } = useArchivedConversationListQuery(assistantId);

  const [pendingUnarchiveId, setPendingUnarchiveId] = useState<string | null>(
    null,
  );

  const handleUnarchive = useCallback(
    async (conversationId: string) => {
      if (!assistantId) return;
      setPendingUnarchiveId(conversationId);
      try {
        await conversationsByIdUnarchivePost({
          path: { assistant_id: assistantId, id: conversationId },
          throwOnError: true,
        });
        // Unarchiving moves a row from the archived list back into the active
        // sidebar list, so invalidate all conversation caches.
        void invalidateConversationQueries(queryClient, assistantId);
      } catch (error) {
        captureError(error, { context: "archive_settings_unarchive_conversation" });
        toast.error("Failed to unarchive conversation.");
      } finally {
        setPendingUnarchiveId(null);
      }
    },
    [assistantId, queryClient],
  );

  const isLoading = isLoadingConversations;

  if (isLoading) {
    return (
      <div className="w-full">
        <div className="flex min-h-[400px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--content-disabled)]" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="w-full">
        <Card>
          <div className="flex min-h-[400px] flex-col items-center justify-center px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--system-error-lighter)]">
              <AlertTriangle className="h-6 w-6 text-[var(--system-error-default)]" />
            </div>
            <h2 className="mt-4 text-title-small text-[var(--content-default)]">
              Failed to load archived conversations
            </h2>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
              Something went wrong. Please try again.
            </p>
            <Button
              variant="outlined"
              onClick={refetch}
              className="mt-4"
            >
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (archived.length === 0) {
    return (
      <div className="w-full">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="w-full">
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
