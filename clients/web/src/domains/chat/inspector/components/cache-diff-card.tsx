/**
 * Cache-diff panel for the Prompt tab. Compares the current call's
 * normalized request prefix against the previous turn's request and names
 * the first logical block that diverged — the "your cache busted here
 * because §X changed" answer to a full cache miss.
 *
 * The current call's sections are already merged onto `entry` by the
 * inspector; the previous call's sections are omitted by the summary-view
 * list endpoint, so this component fetches them on demand via
 * {@link useLlmCallDetail}. All diff logic lives in the pure
 * {@link computeCacheDiff} / {@link collapseDiffContext} helpers; this
 * component owns only fetching and presentation.
 */

import { useState, type ReactNode } from "react";

import {
  collapseDiffContext,
  computeCacheDiff,
  diffLines,
  MAX_ON_DEMAND_DIFF_LINES,
  type CacheDiffChangedGroups,
  type CacheDiffLine,
  type CacheDiffResult,
  type LineDiffSource,
} from "@/domains/chat/inspector/cache-diff";
import { useLlmCallDetail } from "@/domains/chat/inspector/inspector-detail-api";
import { formatCount } from "@/domains/chat/inspector/inspector-formatters";
import { useTranslation } from "@/i18n";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";
import {
  Button,
  Card,
  Notice,
  type NoticeTone,
  Tag,
  type TagTone,
} from "@vellumai/design-library";
type ChatTranslate = ReturnType<typeof useTranslation<"chat">>["t"];

export interface CacheDiffCardProps {
  current: LLMRequestLogEntry;
  previous: LLMRequestLogEntry | null;
  assistantId: string | undefined;
}

interface CacheDiffStatus {
  tone: NoticeTone;
  title: string;
  body: string;
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * Maps the computed bust cause to the status banner copy. Ordered by the
 * provider cache-prefix priority so the headline names the block that
 * re-created the cache first (tools → system → messages), with model and
 * settings as the bracketing special cases.
 */
function buildStatus(
  result: CacheDiffResult,
  t: ChatTranslate,
): CacheDiffStatus {
  switch (result.cause) {
    case "model": {
      const previous =
        result.previousModel ?? t("cacheDiffCard.previousModelFallback");
      const current =
        result.currentModel ?? t("cacheDiffCard.currentModelFallback");
      return {
        tone: "error",
        title: t("cacheDiffCard.statusModelTitle"),
        body: t("cacheDiffCard.statusModelBody", { current, previous }),
      };
    }
    case "tools":
      return {
        tone: "warning",
        title: t("cacheDiffCard.statusToolsTitle"),
        body: t("cacheDiffCard.statusToolsBody"),
      };
    case "system":
      return {
        tone: "warning",
        title: t("cacheDiffCard.statusSystemTitle"),
        body: t("cacheDiffCard.statusSystemBody"),
      };
    case "messages": {
      if (result.firstChangedMessageIndex >= 0) {
        const label =
          result.changedMessageLabel ??
          t("cacheDiffCard.changedMessageFallback");
        return {
          tone: "warning",
          title: t("cacheDiffCard.statusMessagesEarlierTitle"),
          body: t("cacheDiffCard.statusMessagesEarlierBody", {
            label: capitalize(label),
            index: result.firstChangedMessageIndex + 1,
          }),
        };
      }
      return {
        tone: "warning",
        title: t("cacheDiffCard.statusMessagesHistoryTitle"),
        body: t("cacheDiffCard.statusMessagesHistoryBody", {
          removedCount: formatCount(result.removedMessageCount),
        }),
      };
    }
    case "settings":
      return {
        tone: "info",
        title: t("cacheDiffCard.statusSettingsTitle"),
        body: t("cacheDiffCard.statusSettingsBody"),
      };
    case "none":
    case "no-previous":
      return {
        tone: "success",
        title: t("cacheDiffCard.statusPrefixUnchangedTitle"),
        body:
          result.appendedMessageCount > 0
            ? t("cacheDiffCard.statusPrefixUnchangedBodyAppended", {
                count: formatCount(result.appendedMessageCount),
              })
            : t("cacheDiffCard.statusPrefixUnchangedBodyIdentical"),
      };
  }
}

interface ChangedChip {
  key: string;
  label: string;
  tone: TagTone;
}

function changedChips(
  groups: CacheDiffChangedGroups,
  t: ChatTranslate,
): ChangedChip[] {
  const chips: ChangedChip[] = [];
  if (groups.model) {
    chips.push({
      key: "model",
      label: t("cacheDiffCard.chipModel"),
      tone: "negative",
    });
  }
  if (groups.tools) {
    chips.push({
      key: "tools",
      label: t("cacheDiffCard.chipTools"),
      tone: "warning",
    });
  }
  if (groups.system) {
    chips.push({
      key: "system",
      label: t("cacheDiffCard.chipSystem"),
      tone: "warning",
    });
  }
  if (groups.messages) {
    chips.push({
      key: "messages",
      label: t("cacheDiffCard.chipMessages"),
      tone: "warning",
    });
  }
  if (groups.settings) {
    chips.push({
      key: "settings",
      label: t("cacheDiffCard.chipSettings"),
      tone: "neutral",
    });
  }
  return chips;
}

function messageStats(
  result: CacheDiffResult,
  t: ChatTranslate,
): string | null {
  const parts: string[] = [];
  if (result.sharedMessageCount > 0) {
    parts.push(
      t("cacheDiffCard.messageStatsShared", {
        count: formatCount(result.sharedMessageCount),
      }),
    );
  }
  if (result.appendedMessageCount > 0) {
    parts.push(
      t("cacheDiffCard.messageStatsAppended", {
        count: formatCount(result.appendedMessageCount),
      }),
    );
  }
  if (result.removedMessageCount > 0) {
    parts.push(
      t("cacheDiffCard.messageStatsRemoved", {
        count: formatCount(result.removedMessageCount),
      }),
    );
  }
  return parts.length > 0
    ? t("cacheDiffCard.messageStatsLeading", { parts: parts.join(" · ") })
    : null;
}

interface StateNoteProps {
  children: ReactNode;
}

/** Titled card used for the loading / error / unavailable states. */
function StateNote({ children }: StateNoteProps): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <Card>
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {t("cacheDiffCard.title")}
      </p>
      <p
        className="mt-1 text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        {children}
      </p>
    </Card>
  );
}

const MAX_VISIBLE_DIFF_ENTRIES = 120;

interface DiffLineStyle {
  color: string;
  background: string;
  sign: string;
}

function diffLineStyle(type: CacheDiffLine["type"]): DiffLineStyle {
  if (type === "added") {
    return {
      color: "var(--system-positive-strong)",
      background: "var(--system-positive-weak)",
      sign: "+",
    };
  }
  if (type === "removed") {
    return {
      color: "var(--system-negative-strong)",
      background: "var(--system-negative-weak)",
      sign: "-",
    };
  }
  return {
    color: "var(--content-tertiary)",
    background: "transparent",
    sign: " ",
  };
}

type OnDemandDiff =
  | { status: "idle" }
  | { status: "tooLarge" }
  | { status: "ready"; lines: CacheDiffLine[] };

interface DiffPreviewActionsProps {
  truncated: boolean;
  onDemand: OnDemandDiff;
  source: LineDiffSource | null;
  cappedCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onComputeFull: () => void;
}

/**
 * The footnote affordance under a diff: an expand/collapse toggle for the
 * display cap, or — when the text was too large to diff eagerly — a
 * "Diff anyway" button (and the still-too-large fallback).
 */
function DiffPreviewActions({
  truncated,
  onDemand,
  source,
  cappedCount,
  expanded,
  onToggleExpanded,
  onComputeFull,
}: DiffPreviewActionsProps): ReactNode {
  const { t } = useTranslation("chat");

  if (truncated) {
    if (onDemand.status === "tooLarge") {
      return (
        <p
          className="mt-1 text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("cacheDiffCard.diffStillTooLarge", {
            maxLines: formatCount(MAX_ON_DEMAND_DIFF_LINES),
          })}
        </p>
      );
    }
    if (!source) {
      return (
        <p
          className="mt-1 text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("cacheDiffCard.diffTooLarge")}
        </p>
      );
    }
    const lineCount = Math.max(
      source.previousText.split("\n").length,
      source.currentText.split("\n").length,
    );
    return (
      <div className="mt-1 flex flex-col items-start gap-1">
        <p
          className="text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("cacheDiffCard.diffLargeDefault")}
        </p>
        <Button variant="ghost" size="compact" onClick={onComputeFull}>
          {t("cacheDiffCard.diffAnyway", {
            lineCount: formatCount(lineCount),
          })}
        </Button>
      </div>
    );
  }

  if (cappedCount > 0) {
    return (
      <Button
        variant="ghost"
        size="compact"
        className="mt-1"
        onClick={onToggleExpanded}
      >
        {expanded
          ? t("cacheDiffCard.showLess")
          : t("cacheDiffCard.showMoreDiffLines", {
              count: formatCount(cappedCount),
            })}
      </Button>
    );
  }

  return null;
}

interface DiffPreviewProps {
  label: string;
  lines: CacheDiffLine[];
  truncated: boolean;
  source: LineDiffSource | null;
}

/**
 * Renders a collapsed, focused line diff with gap markers for context runs.
 * The display is capped at {@link MAX_VISIBLE_DIFF_ENTRIES} entries with a
 * click-to-expand toggle, and an oversized diff that was skipped on the
 * default render (`truncated`) can be computed on demand from `source`.
 */
function DiffPreview({
  label,
  lines,
  truncated,
  source,
}: DiffPreviewProps): ReactNode {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const [onDemand, setOnDemand] = useState<OnDemandDiff>({ status: "idle" });

  // Computing an oversized diff on demand swaps in the freshly diffed lines
  // and clears the truncation, so the display-cap toggle below takes over.
  const effectiveLines = onDemand.status === "ready" ? onDemand.lines : lines;
  const effectiveTruncated = onDemand.status === "ready" ? false : truncated;

  const entries = collapseDiffContext(effectiveLines);
  const cappedCount = Math.max(entries.length - MAX_VISIBLE_DIFF_ENTRIES, 0);
  const visible = expanded
    ? entries
    : entries.slice(0, MAX_VISIBLE_DIFF_ENTRIES);

  function computeFullDiff(): void {
    if (!source) {
      return;
    }
    const result = diffLines(
      source.previousText,
      source.currentText,
      MAX_ON_DEMAND_DIFF_LINES,
    );
    setOnDemand(
      result && !result.truncated
        ? { status: "ready", lines: result.lines }
        : { status: "tooLarge" },
    );
  }

  return (
    <div className="mt-3">
      <p
        className="text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("cacheDiffCard.diffLabel", { label })}
      </p>
      {visible.length > 0 ? (
        <pre
          className="mt-1 overflow-x-auto rounded-md p-2 text-body-small-default leading-relaxed"
          style={{
            background: "var(--surface-base)",
            border: "1px solid var(--border-base)",
            color: "var(--content-secondary)",
          }}
        >
          {visible.map((entry, index) => {
            if (entry.type === "gap") {
              return (
                <div
                  key={index}
                  className="italic"
                  style={{ color: "var(--content-faint)" }}
                >
                  {t("cacheDiffCard.unchangedLines", {
                    count: formatCount(entry.count),
                  })}
                </div>
              );
            }
            const style = diffLineStyle(entry.line.type);
            return (
              <div
                key={index}
                style={{ color: style.color, background: style.background }}
              >
                {`${style.sign} ${entry.line.text}`}
              </div>
            );
          })}
        </pre>
      ) : null}
      <DiffPreviewActions
        truncated={effectiveTruncated}
        onDemand={onDemand}
        source={source}
        cappedCount={cappedCount}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onComputeFull={computeFullDiff}
      />
    </div>
  );
}

/**
 * Renders the cache-diff panel, or nothing when there is no previous call
 * to compare against (the first call in a conversation) or no current
 * prompt to diff — so callers can drop it in unconditionally.
 */
export function CacheDiffCard({
  current,
  previous,
  assistantId,
}: CacheDiffCardProps): ReactNode {
  const { t } = useTranslation("chat");
  const hasPreviousSections =
    previous != null &&
    previous.requestSections != null &&
    previous.requestSections.length > 0;
  const needsPreviousFetch = previous != null && !hasPreviousSections;

  const {
    data: previousDetail,
    isError: isPreviousError,
    isLoading: isPreviousLoading,
  } = useLlmCallDetail(
    needsPreviousFetch ? assistantId : undefined,
    needsPreviousFetch ? previous?.id : undefined,
  );

  if (!previous) {
    return null;
  }

  const currentSections = current.requestSections ?? [];
  if (currentSections.length === 0) {
    return null;
  }

  if (needsPreviousFetch) {
    if (isPreviousLoading) {
      return (
        <StateNote>{t("cacheDiffCard.loadingPreviousCall")}</StateNote>
      );
    }
    if (isPreviousError) {
      return (
        <StateNote>{t("cacheDiffCard.loadPreviousCallError")}</StateNote>
      );
    }
  }

  const previousSections = hasPreviousSections
    ? previous.requestSections
    : (previousDetail?.requestSections ?? null);
  if (!previousSections || previousSections.length === 0) {
    return (
      <StateNote>{t("cacheDiffCard.previousPromptUnavailable")}</StateNote>
    );
  }

  const result = computeCacheDiff(
    { sections: currentSections, model: current.summary?.model },
    { sections: previousSections, model: previous.summary?.model },
  );

  const status = buildStatus(result, t);
  const chips = changedChips(result.changedGroups, t);
  const stats = messageStats(result, t);

  return (
    <Card>
      <div className="min-w-0">
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {t("cacheDiffCard.title")}
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          {t("cacheDiffCard.description")}
        </p>
      </div>

      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {t("cacheDiffCard.changedLabel")}
          </span>
          {chips.map((chip) => (
            <Tag key={chip.key} tone={chip.tone}>
              {chip.label}
            </Tag>
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <Notice tone={status.tone} title={status.title}>
          {status.body}
        </Notice>
      </div>

      {stats ? (
        <p
          className="mt-2 text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {stats}
        </p>
      ) : null}

      {result.lineDiff && result.lineDiffLabel ? (
        <DiffPreview
          key={current.id}
          label={result.lineDiffLabel}
          lines={result.lineDiff}
          truncated={result.lineDiffTruncated}
          source={result.lineDiffSource}
        />
      ) : null}
    </Card>
  );
}
