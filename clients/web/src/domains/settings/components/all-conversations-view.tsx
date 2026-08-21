/**
 * All-conversations view — a full-page browser over every conversation
 * (active and archived) with search and an All/Active/Archived filter.
 *
 * Thin orchestrator mirroring `domains/library/library-view.tsx`: composes
 * the data-fetching hook, owns the row action callbacks inline (single
 * consumer, matching the library/home pattern), and delegates the row
 * presentation to a focused sub-component. Row actions call the same daemon
 * archive/unarchive primitives the sidebar and the Settings archive tab use,
 * then invalidate the conversation caches so both lists reconcile.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Archive, Loader2, RotateCcw, Search } from "lucide-react";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";

import {
  type AllConversationsRow,
  type ConversationFilter,
  useAllConversationsData,
} from "@/domains/settings/hooks/use-all-conversations-data";
import {
  conversationsByIdArchivePost,
  conversationsByIdUnarchivePost,
} from "@/generated/daemon/sdk.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import type { Conversation } from "@/types/conversation-types";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import { toast } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { Input } from "@vellumai/design-library/components/input";

export interface AllConversationsViewProps {
  assistantId: string;
  title?: string;
  /** Filter the view opens on. `?tab=archive` deep links land on "archived". */
  initialFilter?: ConversationFilter;
  onOpenConversation: (conversationId: string) => void;
}

/** Human-readable timestamp for a conversation row (lifted from the Settings
 *  archive tab so that surface can be retired without losing the format). */
function formatConversationDate(timestamp: number | undefined): string {
  if (timestamp == null) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function ConversationRow({
  row,
  isFirst,
  onOpen,
  onArchive,
  onUnarchive,
  isPending,
}: {
  row: AllConversationsRow;
  isFirst: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation("settings");
  const { conversation, archived } = row;
  const dateText = formatConversationDate(
    conversation.lastMessageAt ?? conversation.createdAt,
  );
  const source = conversation.source ?? "vellum-assistant";
  const meta = [dateText, source].filter(Boolean).join(" · ");
  const title =
    conversation.title && conversation.title.trim().length > 0
      ? conversation.title
      : t("allConversationsView.untitled");

  return (
    <div
      className={`flex items-center gap-3 py-3 ${
        isFirst ? "" : "border-t border-[var(--border-base)]"
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-body-medium-default text-[var(--content-default)]">
          {title}
        </div>
        <p className="mt-0.5 truncate text-body-small-default text-[var(--content-tertiary)]">
          {meta}
        </p>
      </button>
      <Button
        variant="outlined"
        onClick={archived ? onUnarchive : onArchive}
        disabled={isPending}
        className="shrink-0"
      >
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {archived
              ? t("allConversationsView.unarchiving")
              : t("allConversationsView.archiving")}
          </>
        ) : archived ? (
          t("allConversationsView.unarchive")
        ) : (
          <>
            <Archive className="h-4 w-4" />
            {t("allConversationsView.archive")}
          </>
        )}
      </Button>
    </div>
  );
}

export function AllConversationsView({
  assistantId,
  title,
  initialFilter,
  onOpenConversation,
}: AllConversationsViewProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const {
    rows,
    searchText,
    setSearchText,
    filter,
    setFilter,
    loading,
    error,
    refetch,
  } = useAllConversationsData(assistantId, initialFilter);

  const [pendingId, setPendingId] = useState<string | null>(null);

  const filterItems: SelectOption<ConversationFilter>[] = useMemo(
    () => [
      { value: "all", label: t("allConversationsView.filterAll") },
      { value: "active", label: t("allConversationsView.filterActive") },
      { value: "archived", label: t("allConversationsView.filterArchived") },
    ],
    [t],
  );

  const runRowAction = useCallback(
    async (
      conversation: Conversation,
      action: typeof conversationsByIdArchivePost,
      failureMessage: string,
      errorContext: string,
    ) => {
      setPendingId(conversation.conversationId);
      try {
        await action({
          path: { assistant_id: assistantId, id: conversation.conversationId },
          throwOnError: true,
        });
        // Archiving/unarchiving moves a row between the active and archived
        // lists, so invalidate every conversation cache to reconcile both.
        void invalidateConversationQueries(queryClient, assistantId);
      } catch (err) {
        captureError(err, { context: errorContext });
        toast.error(failureMessage);
      } finally {
        setPendingId(null);
      }
    },
    [assistantId, queryClient],
  );

  const handleArchive = useCallback(
    (conversation: Conversation) => {
      void runRowAction(
        conversation,
        conversationsByIdArchivePost,
        t("allConversationsView.archiveFailed"),
        "all_conversations_archive_conversation",
      );
    },
    [runRowAction, t],
  );

  const handleUnarchive = useCallback(
    (conversation: Conversation) => {
      void runRowAction(
        conversation,
        conversationsByIdUnarchivePost,
        t("allConversationsView.unarchiveFailed"),
        "all_conversations_unarchive_conversation",
      );
    },
    [runRowAction, t],
  );

  // --- Render: loading ---
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--primary-base)]"
          role="status"
          aria-label={t("allConversationsView.loading")}
        />
      </div>
    );
  }

  // --- Render: error ---
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("allConversationsView.loadError")}
        </p>
        <Button variant="outlined" onClick={refetch}>
          <RotateCcw className="h-4 w-4" />
          {t("allConversationsView.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {title ? (
        <h1 className="mb-4 shrink-0 text-title-large text-[var(--content-default)]">
          {title}
        </h1>
      ) : null}

      <div className="mb-6 flex shrink-0 items-center gap-2">
        <Input
          fullWidth
          wrapperClassName="min-w-0 flex-1"
          type="text"
          placeholder={t("allConversationsView.searchPlaceholder")}
          value={searchText}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setSearchText(e.target.value)
          }
          leftIcon={<Search size={16} />}
        />
        <Select<ConversationFilter>
          aria-label={t("allConversationsView.filterAria")}
          value={filter}
          onChange={setFilter}
          options={filterItems}
          menuAlign="end"
          className="w-36 shrink-0"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <ConversationsBody
          rows={rows}
          filter={filter}
          searchText={searchText}
          pendingId={pendingId}
          onOpen={onOpenConversation}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
        />
      </div>
    </div>
  );
}

/**
 * Body region: renders the rows, or one of the empty states. Split out so the
 * empty-state branching stays readable and each branch's copy is explicit.
 */
function ConversationsBody({
  rows,
  filter,
  searchText,
  pendingId,
  onOpen,
  onArchive,
  onUnarchive,
}: {
  rows: AllConversationsRow[];
  filter: ConversationFilter;
  searchText: string;
  pendingId: string | null;
  onOpen: (conversationId: string) => void;
  onArchive: (conversation: Conversation) => void;
  onUnarchive: (conversation: Conversation) => void;
}) {
  const { t } = useTranslation("settings");

  if (rows.length === 0) {
    // A trimmed search that matched nothing gets the search-empty copy,
    // regardless of the active filter.
    if (searchText.trim()) {
      return (
        <div className="flex flex-col items-center justify-center py-16">
          <Search size={32} className="mb-4 text-[var(--content-tertiary)]" />
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("allConversationsView.noMatch", { query: searchText })}
          </p>
        </div>
      );
    }

    // Each filter speaks only for the source it fetched: a bucket whose
    // counterpart went unfetched can't tell whether the assistant has any
    // conversations at all. The Archived copy also carries over the Settings
    // archive tab's wording, since this retires that surface.
    const emptyCopy =
      filter === "archived"
        ? t("allConversationsView.emptyArchived")
        : filter === "active"
          ? t("allConversationsView.emptyActive")
          : t("allConversationsView.emptyAll");

    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Archive size={32} className="mb-4 text-[var(--content-tertiary)]" />
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {emptyCopy}
        </p>
      </div>
    );
  }

  return (
    <div>
      {rows.map((row, index) => (
        <ConversationRow
          key={row.conversation.conversationId}
          row={row}
          isFirst={index === 0}
          onOpen={() => onOpen(row.conversation.conversationId)}
          onArchive={() => onArchive(row.conversation)}
          onUnarchive={() => onUnarchive(row.conversation)}
          isPending={pendingId === row.conversation.conversationId}
        />
      ))}
    </div>
  );
}
