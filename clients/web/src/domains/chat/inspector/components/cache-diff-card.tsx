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

import { type ReactNode } from "react";

import {
  collapseDiffContext,
  computeCacheDiff,
  type CacheDiffChangedGroups,
  type CacheDiffLine,
  type CacheDiffResult,
} from "@/domains/chat/inspector/cache-diff";
import { useLlmCallDetail } from "@/domains/chat/inspector/inspector-detail-api";
import { formatCount } from "@/domains/chat/inspector/inspector-formatters";
import type { LLMRequestLogEntry } from "@vellumai/assistant-api";
import { Card, Notice, type NoticeTone, Tag, type TagTone } from "@vellumai/design-library";

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
function buildStatus(result: CacheDiffResult): CacheDiffStatus {
  switch (result.cause) {
    case "model": {
      const previous = result.previousModel ?? "the previous model";
      const current = result.currentModel ?? "this model";
      return {
        tone: "error",
        title: "Model changed",
        body: `This turn used ${current} but the previous turn used ${previous}. A different model can't reuse the previous prompt cache, so the whole prompt is re-created.`,
      };
    }
    case "tools":
      return {
        tone: "warning",
        title: "Tool definitions changed",
        body: "The tool set or its definitions differ from the previous turn. Tools sit at the front of the cached prefix, so any change here re-creates the cache before it reaches the system prompt and messages.",
      };
    case "system":
      return {
        tone: "warning",
        title: "System prompt changed",
        body: "Part of the system prompt changed since the previous turn. Volatile content here — a timestamp, memory, or a per-turn block — re-creates the cache every turn.",
      };
    case "messages": {
      if (result.firstChangedMessageIndex >= 0) {
        const label = result.changedMessageLabel ?? "a message";
        return {
          tone: "warning",
          title: "An earlier message changed",
          body: `${capitalize(label)} #${result.firstChangedMessageIndex + 1} differs from the previous turn, so everything cached after it is re-processed this turn.`,
        };
      }
      return {
        tone: "warning",
        title: "Message history changed",
        body: `${formatCount(result.removedMessageCount)} earlier message(s) are gone this turn (likely history compaction), so the cached message prefix no longer matches.`,
      };
    }
    case "settings":
      return {
        tone: "info",
        title: "Request settings changed",
        body: "Only request settings (e.g. temperature) differ from the previous turn. For most providers this alone won't bust the prompt cache.",
      };
    case "none":
    case "no-previous":
      return {
        tone: "success",
        title: "Prompt prefix unchanged",
        body:
          result.appendedMessageCount > 0
            ? `The cached prefix matches the previous turn and ${formatCount(result.appendedMessageCount)} new message(s) were appended. A cache miss here points to cache TTL expiry rather than changed content.`
            : "The cached prefix is identical to the previous turn. A cache miss here points to cache TTL expiry rather than changed content.",
      };
  }
}

interface ChangedChip {
  key: string;
  label: string;
  tone: TagTone;
}

function changedChips(groups: CacheDiffChangedGroups): ChangedChip[] {
  const chips: ChangedChip[] = [];
  if (groups.model) chips.push({ key: "model", label: "Model", tone: "negative" });
  if (groups.tools) chips.push({ key: "tools", label: "Tools", tone: "warning" });
  if (groups.system) chips.push({ key: "system", label: "System", tone: "warning" });
  if (groups.messages) {
    chips.push({ key: "messages", label: "Messages", tone: "warning" });
  }
  if (groups.settings) {
    chips.push({ key: "settings", label: "Settings", tone: "neutral" });
  }
  return chips;
}

function messageStats(result: CacheDiffResult): string | null {
  const parts: string[] = [];
  if (result.sharedMessageCount > 0) {
    parts.push(`${formatCount(result.sharedMessageCount)} shared`);
  }
  if (result.appendedMessageCount > 0) {
    parts.push(`${formatCount(result.appendedMessageCount)} appended`);
  }
  if (result.removedMessageCount > 0) {
    parts.push(`${formatCount(result.removedMessageCount)} removed`);
  }
  return parts.length > 0 ? `Leading messages: ${parts.join(" · ")}` : null;
}

interface StateNoteProps {
  children: ReactNode;
}

/** Titled card used for the loading / error / unavailable states. */
function StateNote({ children }: StateNoteProps): ReactNode {
  return (
    <Card>
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        Cache diff
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

interface DiffPreviewProps {
  label: string;
  lines: CacheDiffLine[];
  truncated: boolean;
}

/** Renders a collapsed, focused line diff with gap markers for context runs. */
function DiffPreview({ label, lines, truncated }: DiffPreviewProps): ReactNode {
  const entries = collapseDiffContext(lines);
  const visible = entries.slice(0, MAX_VISIBLE_DIFF_ENTRIES);
  const hiddenCount = entries.length - visible.length;

  let footnote: string | null = null;
  if (truncated) {
    footnote =
      "The changed text is too large to diff here — open the Raw tab for the full payload.";
  } else if (hiddenCount > 0) {
    footnote = `${formatCount(hiddenCount)} more diff line(s) hidden — open the Raw tab for the full diff.`;
  }

  return (
    <div className="mt-3">
      <p
        className="text-label-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label} diff
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
                  {`⋯ ${formatCount(entry.count)} unchanged line(s)`}
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
      {footnote ? (
        <p
          className="mt-1 text-label-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {footnote}
        </p>
      ) : null}
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

  if (!previous) return null;

  const currentSections = current.requestSections ?? [];
  if (currentSections.length === 0) return null;

  if (needsPreviousFetch) {
    if (isPreviousLoading) {
      return <StateNote>Loading the previous call to compare…</StateNote>;
    }
    if (isPreviousError) {
      return <StateNote>Couldn't load the previous call to diff against.</StateNote>;
    }
  }

  const previousSections = hasPreviousSections
    ? previous.requestSections
    : (previousDetail?.requestSections ?? null);
  if (!previousSections || previousSections.length === 0) {
    return <StateNote>The previous call's prompt isn't available to compare.</StateNote>;
  }

  const result = computeCacheDiff(
    { sections: currentSections, model: current.summary?.model },
    { sections: previousSections, model: previous.summary?.model },
  );

  const status = buildStatus(result);
  const chips = changedChips(result.changedGroups);
  const stats = messageStats(result);

  return (
    <Card>
      <div className="min-w-0">
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          Cache diff
        </p>
        <p
          className="mt-1 text-body-medium-lighter"
          style={{ color: "var(--content-secondary)" }}
        >
          What changed since the previous turn's request — the block that
          re-created the prompt cache.
        </p>
      </div>

      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span
            className="text-label-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            Changed
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
          label={result.lineDiffLabel}
          lines={result.lineDiff}
          truncated={result.lineDiffTruncated}
        />
      ) : null}
    </Card>
  );
}
