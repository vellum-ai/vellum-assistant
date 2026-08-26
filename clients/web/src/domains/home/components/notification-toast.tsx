import { Bell, CircleAlert, X } from "lucide-react";

import { useTranslation } from "@/i18n";

import type { FeedItemBucket } from "@vellumai/assistant-api";
import { cn, Typography } from "@vellumai/design-library";

export interface NotificationToastProps {
  bucket: FeedItemBucket;
  title: string;
  body: string;
  /** Inline action, so a needs-you toast can be answered without opening anything. */
  actionLabel?: string;
  onAction?: () => void;
  /** Whole-card click target: the run, its conversation, or its output. */
  onOpen?: () => void;
  onDismiss: () => void;
}

/**
 * The card an in-app notification toast draws.
 *
 * Built rather than composed from the design library's `toast()` helper for
 * one reason: the whole card is a click target here, straight through to the
 * run, its conversation, or what it produced. The helper's card is inert
 * except for its one action link, which would leave the toast's main job (get
 * me to the thing) to a footnote. Everything else about the treatment (the
 * box, the padding, the close control) matches the helper, so a notification
 * toast and an ordinary one read as siblings.
 *
 * Needs-you toasts are tinted and announce assertively; worth-knowing toasts
 * are quiet. There is no activity variant, because routine work never toasts.
 */
export function NotificationToast({
  bucket,
  title,
  body,
  actionLabel,
  onAction,
  onOpen,
  onDismiss,
}: NotificationToastProps) {
  const { t } = useTranslation("home");
  const needsYou = bucket === "needs_you";
  const Icon = needsYou ? CircleAlert : Bell;

  return (
    <div
      role={needsYou ? "alert" : "status"}
      data-slot="toast"
      data-testid="notification-toast"
      className={cn(
        "relative flex max-h-[300px] w-full items-start gap-3 rounded-lg border p-3 shadow-lg",
        needsYou
          ? "border-transparent bg-[var(--system-mid-weak)] text-[var(--system-mid-strong)]"
          : "border-[var(--border-base)] bg-[var(--surface-overlay)] text-[var(--content-default)]",
      )}
    >
      {/* Stretched link, the same arrangement the feed rows use: one target
          covering the card, with the close control and the inline action
          stacked above it so their clicks are not swallowed. */}
      {onOpen ? (
        <button
          type="button"
          aria-label={title}
          onClick={onOpen}
          className="absolute inset-0 cursor-pointer rounded-lg"
        />
      ) : null}

      <span className="pointer-events-none relative mt-0.5 shrink-0">
        <Icon className="size-4" />
      </span>

      <div className="pointer-events-none relative min-w-0 flex-1 space-y-1">
        <Typography variant="body-medium-default" className="line-clamp-1">
          {title}
        </Typography>
        <Typography variant="body-small-default" className="line-clamp-2 opacity-70">
          {body}
        </Typography>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="pointer-events-auto mt-1.5 cursor-pointer bg-transparent text-body-small-default underline underline-offset-2 hover:no-underline"
          >
            {actionLabel}
          </button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("feedToast.close")}
        className="relative shrink-0 cursor-pointer rounded bg-transparent p-0.5 opacity-50 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
