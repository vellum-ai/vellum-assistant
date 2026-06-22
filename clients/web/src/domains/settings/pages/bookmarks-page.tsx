import { AlertTriangle, Bookmark, Loader2, RotateCcw, X } from "lucide-react";
import { useNavigate } from "react-router";

import {
  type Bookmark as BookmarkSummary,
  useBookmarks,
  useBookmarkToggle,
} from "@/hooks/use-bookmarks";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";

function formatBookmarkDate(timestamp: number | undefined): string {
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
          <Bookmark className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]" />
        </div>
        <h2 className="mt-4 text-title-small text-[var(--content-default)]">
          No bookmarks
        </h2>
        <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
          Hover any message and click the bookmark icon to save it here.
        </p>
      </div>
    </Card>
  );
}

function BookmarkRow({
  bookmark,
  isFirst,
  onOpen,
  onRemove,
}: {
  bookmark: BookmarkSummary;
  isFirst: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const title =
    bookmark.conversationTitle && bookmark.conversationTitle.trim().length > 0
      ? bookmark.conversationTitle
      : "Untitled conversation";
  // Accent the source: assistant replies read stronger than the user's own
  // lines, matching the legacy macOS Bookmarks tab.
  const isAssistant = bookmark.messageRole !== "user";
  const savedAt = formatBookmarkDate(bookmark.createdAt);

  return (
    <div
      className={`flex items-start gap-3 py-3 ${
        isFirst ? "" : "border-t border-[var(--border-base)]"
      }`}
    >
      <span
        aria-hidden
        className="mt-1 h-8 w-1 shrink-0 rounded-full"
        style={{
          backgroundColor: isAssistant
            ? "var(--content-default)"
            : "var(--content-tertiary)",
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="truncate text-body-medium-default text-[var(--content-default)]">
            {title}
          </div>
          {savedAt ? (
            <span className="shrink-0 text-body-small-default text-[var(--content-tertiary)]">
              {savedAt}
            </span>
          ) : null}
        </div>
        {bookmark.messagePreview ? (
          <p className="mt-0.5 line-clamp-2 text-body-small-default text-[var(--content-tertiary)]">
            {bookmark.messagePreview}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outlined" onClick={onOpen}>
          Open
        </Button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove bookmark"
          aria-label="Remove bookmark"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function BookmarksPage() {
  const navigate = useNavigate();
  const { bookmarks, isLoading, isError, refetch } = useBookmarks();
  const toggleBookmark = useBookmarkToggle();

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
              Failed to load bookmarks
            </h2>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
              Something went wrong. Please try again.
            </p>
            <Button variant="outlined" onClick={refetch} className="mt-4">
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <div className="w-full">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="w-full">
      <Card noPadding className="px-4">
        {bookmarks.map((bookmark, index) => (
          <BookmarkRow
            key={bookmark.id}
            bookmark={bookmark}
            isFirst={index === 0}
            onOpen={() => {
              navigate(
                routes.conversationAtMessage(
                  bookmark.conversationId,
                  bookmark.messageId,
                ),
              );
            }}
            onRemove={() => {
              void toggleBookmark(
                bookmark.messageId,
                bookmark.conversationId,
                true,
              );
            }}
          />
        ))}
      </Card>
    </div>
  );
}
