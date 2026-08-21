import { Button, Tag, Typography } from "@vellumai/design-library";
import {
  CheckCircle,
  CircleDot,
  MessageSquare,
  Quote,
  Trash2,
  User,
} from "lucide-react";
import { useCallback, useState } from "react";

import { currentLocale, useTranslation } from "@/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

import type { DocumentsByIdCommentsPostResponse } from "@/generated/daemon/types.gen";
import { DocumentCommentForm } from "./document-comment-form";

type ChatTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

function authorLabel(
  author: DocumentsByIdCommentsPostResponse["author"],
  t: ChatTranslate,
): string {
  return author === "assistant"
    ? t("documentCommentThread.authorAssistant")
    : t("documentCommentThread.authorYou");
}

// ---------------------------------------------------------------------------
// Single comment bubble
// ---------------------------------------------------------------------------

function CommentBubble({
  comment,
  onCommentSelect,
}: {
  comment: DocumentsByIdCommentsPostResponse;
  onCommentSelect?: (comment: DocumentsByIdCommentsPostResponse) => void;
}) {
  const { t } = useTranslation("chat");
  const isInline = comment.anchorText != null;
  return (
    <div className="flex gap-2">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{
          backgroundColor:
            comment.author === "assistant"
              ? "var(--primary-second-hover)"
              : "var(--surface-active)",
        }}
        aria-hidden="true"
      >
        {comment.author === "assistant" ? (
          <Typography
            variant="label-small-default"
            className="text-[var(--primary-base)]"
          >
            {t("documentCommentThread.assistantMonogram")}
          </Typography>
        ) : (
          <User size={12} style={{ color: "var(--content-secondary)" }} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Typography
            variant="body-small-emphasised"
            className="text-[var(--content-emphasised)]"
          >
            {authorLabel(comment.author, t)}
          </Typography>
          <Typography
            variant="label-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {formatRelativeTime(comment.createdAt, {
              locale: currentLocale(),
              minimumUnit: "minute",
            })}
          </Typography>
        </div>

        {isInline ? (
          <button
            type="button"
            className="mt-1 cursor-pointer border-none bg-transparent p-0"
            onClick={() => onCommentSelect?.(comment)}
            title={t("documentCommentThread.jumpToHighlight")}
          >
            <Tag tone="neutral" leftIcon={<Quote />}>
              <span className="max-w-[200px] truncate">
                {comment.anchorText}
              </span>
            </Tag>
          </button>
        ) : null}

        <Typography
          variant="body-small-default"
          as="p"
          className="mt-1 text-[var(--content-default)] whitespace-pre-wrap break-words"
        >
          {comment.content}
        </Typography>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread component
// ---------------------------------------------------------------------------

export interface DocumentCommentThreadProps {
  comment: DocumentsByIdCommentsPostResponse;
  replies: DocumentsByIdCommentsPostResponse[];
  onResolve: (commentId: string) => Promise<void>;
  onReopen: (commentId: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onReply: (parentCommentId: string, content: string) => Promise<void>;
  onCommentSelect?: (comment: DocumentsByIdCommentsPostResponse) => void;
}

/**
 * Renders a top-level comment with its reply chain. Provides action buttons
 * for resolve/reopen/delete and a collapsible reply form.
 */
export function DocumentCommentThread({
  comment,
  replies,
  onResolve,
  onReopen,
  onDelete,
  onReply,
  onCommentSelect,
}: DocumentCommentThreadProps) {
  const { t } = useTranslation("chat");
  const [replyOpen, setReplyOpen] = useState(false);
  const isResolved = comment.status === "resolved";

  const handleReply = useCallback(
    async (content: string) => {
      await onReply(comment.id, content);
      setReplyOpen(false);
    },
    [comment.id, onReply],
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-base)] p-3"
      style={{
        backgroundColor: isResolved
          ? "var(--surface-base)"
          : "var(--surface-overlay)",
      }}
    >
      <div className="flex items-center justify-between">
        {isResolved ? (
          <Tag tone="positive" leftIcon={<CheckCircle />}>
            {t("documentCommentThread.resolved")}
          </Tag>
        ) : (
          <Tag tone="neutral" leftIcon={<CircleDot />}>
            {t("documentCommentThread.open")}
          </Tag>
        )}

        <div className="flex items-center gap-1">
          {isResolved ? (
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<CircleDot />}
              onClick={() => void onReopen(comment.id)}
            >
              {t("documentCommentThread.reopen")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<CheckCircle />}
              onClick={() => void onResolve(comment.id)}
            >
              {t("documentCommentThread.resolve")}
            </Button>
          )}
          <Button
            variant="dangerGhost"
            size="compact"
            iconOnly={<Trash2 />}
            aria-label={t("documentCommentThread.deleteCommentAria")}
            onClick={() => void onDelete(comment.id)}
          />
        </div>
      </div>

      <CommentBubble comment={comment} onCommentSelect={onCommentSelect} />

      {replies.length > 0 ? (
        <div className="ml-8 flex flex-col gap-3 border-l-2 border-[var(--border-base)] pl-3">
          {replies.map((reply) => (
            <CommentBubble
              key={reply.id}
              comment={reply}
              onCommentSelect={onCommentSelect}
            />
          ))}
        </div>
      ) : null}

      {replyOpen ? (
        <div className="ml-8">
          <DocumentCommentForm
            onSubmit={handleReply}
            placeholder={t("documentCommentThread.replyPlaceholder")}
            autoFocus
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<MessageSquare />}
          onClick={() => setReplyOpen(true)}
          className="self-start"
        >
          {t("documentCommentThread.reply")}
        </Button>
      )}
    </div>
  );
}
