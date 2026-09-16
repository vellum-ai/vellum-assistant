import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import {
  Camera,
  ChevronRight,
  Globe,
  Monitor,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { Collapsible, Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

import {
  describeSessionGroupSummary,
  isActiveSessionGroupState,
  type SessionGroupSummaryDescriptor,
  type SessionGroupSummaryInput,
} from "./session-group-summary";

const SESSION_VALUE = "session";

export type SessionGroupMode =
  | "computerUse"
  | "browser"
  | "liveVision"
  | "ambient";

const MODE_ICONS: Record<SessionGroupMode, LucideIcon> = {
  computerUse: Monitor,
  browser: Globe,
  liveVision: Camera,
  ambient: Waves,
};

const MODE_TITLE_KEYS = {
  computerUse: "sessionGroupRow.mode.computerUse",
  browser: "sessionGroupRow.mode.browser",
  liveVision: "sessionGroupRow.mode.liveVision",
  ambient: "sessionGroupRow.mode.ambient",
} as const;

const ACTIVE_SUMMARY_KEYS = {
  working: {
    plain: "sessionGroupRow.working",
    withDuration: "sessionGroupRow.workingWithDuration",
  },
  waiting: {
    plain: "sessionGroupRow.waiting",
    withDuration: "sessionGroupRow.waitingWithDuration",
  },
  finishing: {
    plain: "sessionGroupRow.finishing",
    withDuration: "sessionGroupRow.finishingWithDuration",
  },
} as const;

export interface SessionGroupRowProps {
  mode: SessionGroupMode;
  summary: SessionGroupSummaryInput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Keeps the reply subtree mounted while its grouping header arrives. */
  headerVisible?: boolean;
  children: ReactNode;
}

type ChatTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

function formatDuration(seconds: number, t: ChatTranslate): string {
  if (seconds < 60) {
    return t("sessionGroupRow.durationSeconds", { count: seconds });
  }
  return t("sessionGroupRow.durationMinutes", {
    count: Math.max(1, Math.round(seconds / 60)),
  });
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function formatSummary(
  descriptor: SessionGroupSummaryDescriptor,
  t: ChatTranslate,
  locale: string,
): string {
  const duration =
    descriptor.durationSeconds === null
      ? null
      : formatDuration(descriptor.durationSeconds, t);
  const endTime =
    descriptor.endedAt === null
      ? null
      : formatTime(descriptor.endedAt, locale);
  const lastActivityTime =
    descriptor.lastActivityAt === null
      ? null
      : formatTime(descriptor.lastActivityAt, locale);

  switch (descriptor.state) {
    case "working":
    case "waiting":
    case "finishing": {
      const keys = ACTIVE_SUMMARY_KEYS[descriptor.state];
      return duration === null
        ? t(keys.plain)
        : t(keys.withDuration, { duration });
    }
    case "completed":
    case "settledSegment": {
      if (duration !== null && endTime !== null) {
        return t("sessionGroupRow.completedWithDurationAndEnd", {
          duration,
          endTime,
        });
      }
      if (duration !== null) {
        return t("sessionGroupRow.completedWithDuration", { duration });
      }
      if (endTime !== null) {
        return t("sessionGroupRow.completedWithEnd", { endTime });
      }
      return t("sessionGroupRow.timingUnavailable");
    }
    case "interrupted": {
      if (duration !== null && endTime !== null) {
        return t("sessionGroupRow.interruptedWithDurationAndEnd", {
          duration,
          endTime,
        });
      }
      if (endTime !== null) {
        return t("sessionGroupRow.interruptedWithEnd", { endTime });
      }
      if (duration !== null && lastActivityTime !== null) {
        return t("sessionGroupRow.interruptedWithDurationAndLastActivity", {
          duration,
          lastActivityTime,
        });
      }
      if (lastActivityTime !== null) {
        return t("sessionGroupRow.interruptedWithLastActivity", {
          lastActivityTime,
        });
      }
      return t("sessionGroupRow.interrupted");
    }
    case "unavailable":
      return t("sessionGroupRow.timingUnavailable");
  }
}

/**
 * Controlled disclosure for a recorded mode session. The caller owns visit
 * state and the surrounding transcript column; this component owns only its
 * header, exit motion, and nested rail.
 */
export function SessionGroupRow({
  mode,
  summary,
  open,
  onOpenChange,
  headerVisible = true,
  children,
}: SessionGroupRowProps) {
  const { t, i18n } = useTranslation("chat");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const descriptor = describeSessionGroupSummary(summary);
  const ModeIcon = MODE_ICONS[mode];
  const title = t(MODE_TITLE_KEYS[mode]);
  const summaryText = formatSummary(
    descriptor,
    t,
    i18n.resolvedLanguage ?? i18n.language,
  );

  const focusTriggerFromContent = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      contentRef.current?.contains(activeElement)
    ) {
      triggerRef.current?.focus();
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      focusTriggerFromContent();
    }
  }, [focusTriggerFromContent, open]);

  const handleValueChange = (value: string) => {
    const nextOpen = value === SESSION_VALUE;
    if (!nextOpen) {
      focusTriggerFromContent();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Collapsible.Root
      type="single"
      collapsible
      value={open ? SESSION_VALUE : ""}
      onValueChange={handleValueChange}
      data-session-mode={mode}
      data-header-visible={headerVisible}
    >
      <Collapsible.Item value={SESSION_VALUE}>
        <Collapsible.Trigger
          ref={triggerRef}
          hidden={!headerVisible}
          disabled={!headerVisible}
          aria-hidden={!headerVisible}
          tabIndex={headerVisible ? 0 : -1}
          data-testid="session-group-trigger"
          className={cn(
            "group w-full gap-2.5 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] px-3 py-2.5 text-left",
            "bg-[var(--surface-overlay)] transition-colors hover:bg-[var(--surface-hover)]",
            "data-[state=open]:bg-[var(--surface-hover)]",
            "animate-in fade-in [animation-duration:var(--anim-standard)] motion-reduce:animate-none motion-reduce:transition-none",
          )}
        >
          <ModeIcon
            aria-hidden
            className="size-4 shrink-0 text-[var(--content-tertiary)]"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <Typography
                variant="label-small-default"
                className="truncate text-[var(--content-default)]"
              >
                {title}
              </Typography>
              {isActiveSessionGroupState(descriptor.state) ? (
                <span
                  aria-hidden
                  data-testid="session-group-live-indicator"
                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--primary-base)] motion-reduce:animate-none"
                />
              ) : null}
            </span>
            <Typography
              variant="body-small-lighter"
              className="truncate text-[var(--content-tertiary)]"
            >
              {summaryText}
            </Typography>
          </span>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-[var(--content-tertiary)] transition-transform duration-[var(--anim-standard)] ease-[var(--anim-spring)] group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
        <Collapsible.Content
          ref={contentRef}
          data-testid="session-group-content"
          style={{ animationDuration: "var(--anim-standard)" }}
          className="origin-top transition-[opacity,transform] ease-[var(--anim-spring)] data-[state=closed]:-translate-y-1 data-[state=closed]:opacity-0 data-[state=open]:translate-y-0 data-[state=open]:opacity-100 motion-reduce:translate-y-0 motion-reduce:animate-none motion-reduce:transition-none"
        >
          <div
            className={cn(
              "flex flex-col pb-1",
              headerVisible
                ? "ml-[7px] border-l border-[var(--border-element)] pl-4 pt-3"
                : "ml-0 border-l border-transparent pl-0 pt-0",
            )}
          >
            {children}
          </div>
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
