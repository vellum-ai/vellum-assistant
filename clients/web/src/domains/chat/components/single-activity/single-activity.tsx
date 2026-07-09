/**
 * Inline single-activity link — the lone affordance for ONE step of agent work,
 * in one of three variants:
 *
 *   - `variant="thinking"` — an assistant reasoning run. A brain glyph +
 *     "Thought process"; while streaming the label reads "Thinking" (or the
 *     live reasoning preview) rendered through the avatar-tinted
 *     {@link StreamingShimmerText}. OWNS the streaming/loading state so it can be the single
 *     thinking affordance from the start of a turn, staying clickable so the
 *     live reasoning opens in the drawer as it arrives; no-ops once settled with
 *     empty content (see `shouldShowThinkingIndicator`).
 *   - `variant="tool"` — a LONE renderable tool call (non-web, no confirmation,
 *     no thinking). The derived tool glyph + activity label + optional risk
 *     badge.
 *   - `variant="web"` — a LONE web search. An inline link reading
 *     "Web Search | <latest page title>" — while the search is in flight the
 *     info slot rotates the searched sites via {@link WebsiteCarousel}; once
 *     settled it shows the latest page title as static text. Unlike the other
 *     two variants it expands IN PLACE (controlled via `expanded`/`onExpandChange`)
 *     to reveal the clickable favicon result pills (and `+N more` overflow), or
 *     the error row for a `web_search_error` step — it does NOT open the drawer,
 *     so its trailing glyph is an up/down chevron rather than `ChevronRight`.
 *
 * The thinking/tool variants render the same minimal, container-less button
 * (leading glyph + label + optional risk badge + trailing chevron) and toggle
 * the shared tool-detail side drawer — clicking an already-open link closes it
 * (toggle). The trailing `ChevronRight` signals "opens a drawer" (vs the card's
 * expand-in-place up/down chevron). Consistent padding lets the active highlight
 * fill behind the content without shifting layout.
 *
 * This is the single-step counterpart to `MultiActivityGroup`, which renders a
 * contiguous run of interleaved thinking + tool steps as one combined card.
 */

import {
  Bolt,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Globe,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "@/utils/misc";
import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { deriveStepLabel } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import {
  toolDetailPayloadFromToolCall,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel";
import { SiteFavicon } from "@/domains/chat/components/web-search/site-favicon";
import { useStreamingThinkingPreview } from "@/domains/chat/hooks/use-streaming-thinking-preview";
import { sameThinkingTarget, useViewerStore } from "@/stores/viewer-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { WebSearchResultItem } from "@/assistant/web-activity-types";

export type SingleActivityProps =
  | {
      variant: "thinking";
      /** The accumulated reasoning text (markdown), shown in the drawer. */
      content: string;
      /** Whether the reasoning is still streaming in (drives the glyph + label). */
      isStreaming?: boolean;
      /**
       * Stable identity of this reasoning run (the owning message id + its
       * group index in `groupContentBlocks`). Carried into the drawer payload so
       * the open panel re-derives live text instead of freezing `content`.
       */
      messageId?: string;
      groupIndex?: number;
    }
  | {
      variant: "tool";
      toolCall: ChatMessageToolCall;
    }
  | {
      variant: "web";
      /** Fallback static title (latest searched website) when the carousel isn't shown. */
      info: string;
      /** Websites to feed the rotating WebsiteCarousel in the header info slot. */
      carouselItems: WebSearchResultItem[];
      /** Card-level state: while `loading` the "Web Search" label shimmers. */
      state: "loading" | "complete" | "error";
      /** The single web step to render when expanded (favicon chips / error). Null during the brief loading window before metadata arrives. */
      step: Extract<ToolCallCardStep, { kind: "web_search" | "web_search_error" }> | null;
      /** Controlled expand state + change handler (owned by the caller). */
      expanded: boolean;
      onExpandChange: (next: boolean) => void;
    };

/** The shared presentational shape both variants resolve into. */
interface ResolvedView {
  dataTestId: string;
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  /**
   * When `true`, the label renders through {@link StreamingShimmerText} — the
   * avatar-tinted gradient glint that marks in-flight work (streaming
   * reasoning). The three-dot pulse is retired in its favor.
   */
  shimmerLabel?: boolean;
  riskLevel?: string;
  tone: "default" | "error";
  active: boolean;
  onClick: () => void;
}

export function SingleActivity(props: SingleActivityProps) {
  // Both variants TOGGLE the shared tool-detail drawer and read its active
  // payload to drive the selected highlight. Hooks run unconditionally; the only
  // early return (empty, settled thinking) happens after them below.
  const toggleToolDetail = useViewerStore.use.toggleToolDetail();
  const activeDetail = useViewerStore.use.activeToolDetail();
  const streamingThinkingPreview = useStreamingThinkingPreview(
    props.variant === "thinking" ? props.content : "",
    props.variant === "thinking" && props.isStreaming === true,
  );

  // The web variant feeds a rotating carousel into the header info slot. Memoize
  // the element so it stays referentially stable (a fresh element each render
  // would remount the carousel and reset its rotation). Computed unconditionally
  // at the top level — accessing the web-only prop via a type guard — so this
  // hook is never conditional regardless of variant.
  const carouselItems =
    props.variant === "web" ? props.carouselItems : undefined;
  const carouselNode = useMemo(
    () =>
      carouselItems && carouselItems.length > 0 ? (
        <WebsiteCarousel items={carouselItems} />
      ) : null,
    [carouselItems],
  );

  if (props.variant === "web") {
    const { info, carouselItems, state, step, expanded, onExpandChange } =
      props;
    const isError = state === "error";
    // The settled header shows the LAST result's title (`info`); pull the
    // matching result so we can render its favicon immediately left of it.
    const latest = carouselItems.at(-1);
    const ExpandChevron = expanded ? ChevronUp : ChevronDown;
    return (
      <div className="flex flex-col items-start">
        <button
          type="button"
          data-testid="inline-web-link"
          aria-expanded={expanded}
          aria-label="Web Search"
          onClick={() => onExpandChange(!expanded)}
          className={cn(
            "group inline-flex items-center gap-2 -mx-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium transition-colors cursor-pointer",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]",
            "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
            isError && "text-[var(--system-negative-strong)]",
          )}
        >
          <span
            className={cn(
              "inline-flex shrink-0 items-center text-[var(--content-tertiary)]",
              isError && "text-[var(--system-negative-strong)]",
            )}
          >
            <Globe className="size-4 shrink-0" aria-hidden />
          </span>
          {/* While the search is in flight the label carries the loading
              signal — an avatar-tinted gradient glint sweeps across it. */}
          {state === "loading" ? (
            <StreamingShimmerText
              data-testid="inline-web-loading"
              className="shrink-0"
            >
              Web Search
            </StreamingShimmerText>
          ) : (
            <span className="shrink-0">Web Search</span>
          )}
          <span aria-hidden className="shrink-0 text-[var(--content-tertiary)]">
            |
          </span>
          {/* While searching, rotate through the sites being searched; once
              settled, show the latest page title as static text (the carousel's
              absolutely-positioned chip has no intrinsic width inline, so it
              only belongs in the loading state where the fixed-width slot gives
              it room). */}
          {state === "loading" && carouselNode ? (
            <span className="inline-flex w-[220px] min-w-0 items-center">
              {carouselNode}
            </span>
          ) : latest &&
            (latest.faviconUrl || latest.domain || latest.title) ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <SiteFavicon
                faviconUrl={latest.faviconUrl}
                domain={latest.domain}
                title={info}
                className="shrink-0"
              />
              <span className="min-w-0 max-w-[280px] truncate text-[var(--content-default)]">
                {info}
              </span>
            </span>
          ) : (
            <span className="min-w-0 max-w-[280px] truncate text-[var(--content-default)]">
              {info}
            </span>
          )}
          <ExpandChevron
            className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
            aria-hidden
          />
        </button>
        {expanded && step != null ? (
          <div className="pl-6">
            {step.kind === "web_search_error" ? (
              <WebSearchErrorRow step={step} />
            ) : (
              <WebSearchStepRow step={step} />
            )}
          </div>
        ) : null}
      </div>
    );
  }

  let view: ResolvedView;

  if (props.variant === "thinking") {
    const { content, isStreaming = false, messageId, groupIndex } = props;
    // While streaming, render even before any reasoning text has landed so this
    // link can be the single thinking affordance from the start of the turn.
    // Once settled, an empty thought process has nothing to show, so collapse it.
    if (!content && !isStreaming) return null;
    view = {
      dataTestId: "thought-process-link",
      ariaLabel: "View thinking",
      icon: <Brain className="size-4 shrink-0" aria-hidden />,
      label: isStreaming
        ? (streamingThinkingPreview ?? "Thinking")
        : "Thought process",
      // Streaming state is carried by the label itself — the avatar-tinted
      // shimmer sweep — so the glyph stays the stable brain.
      shimmerLabel: isStreaming,
      tone: "default",
      // Thinking payloads carry an empty `toolCallId`; the bare panel addresses
      // the whole group (no segment index), so match on its (message, group)
      // identity — `sameThinkingTarget` holds the highlight while the reasoning
      // streams, and falls back to text for identity-less callers.
      active:
        activeDetail?.kind === "thinking" &&
        sameThinkingTarget(activeDetail, {
          messageId,
          thinkingGroupIndex: groupIndex,
          thinkingText: content,
        }),
      onClick: () =>
        toggleToolDetail({
          kind: "thinking",
          toolCallId: "",
          toolName: "",
          title: "Thought process",
          activity: "",
          input: {},
          status: "completed",
          thinkingText: content,
          messageId,
          thinkingGroupIndex: groupIndex,
        }),
    };
  } else {
    const { toolCall } = props;
    const { iconName, activity, info, title } = deriveStepLabel(toolCall);
    const Glyph = ICON_MAP[iconName] ?? Bolt;
    const label = activity || info || title;
    const isError =
      Boolean(toolCall.isError) ||
      toolCall.confirmationDecision === "denied" ||
      toolCall.confirmationDecision === "timed_out";
    view = {
      dataTestId: "inline-tool-link",
      ariaLabel: `View details: ${label}`,
      // Running state just shows the static tool icon (no spinner) — a lone fast
      // tool resolves quickly, so the spinner-free chip is acceptable.
      icon: (
        <Glyph
          className="size-4 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden
        />
      ),
      label,
      riskLevel: toolCall.riskLevel,
      tone: isError ? "error" : "default",
      // A lone run never opens the drawer for a thinking payload; match purely
      // on the active tool-call id.
      active:
        activeDetail != null &&
        activeDetail.kind !== "thinking" &&
        activeDetail.toolCallId === toolCall.id,
      onClick: () => toggleToolDetail(toolDetailPayloadFromToolCall(toolCall)),
    };
  }

  const isError = view.tone === "error";
  return (
    <button
      type="button"
      data-testid={view.dataTestId}
      data-active={view.active ? "true" : "false"}
      aria-label={view.ariaLabel}
      onClick={view.onClick}
      className={cn(
        "group inline-flex items-center gap-2 -mx-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium transition-colors cursor-pointer",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]",
        view.active
          ? "bg-[var(--surface-active)] text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        isError && "text-[var(--system-negative-strong)]",
      )}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center text-[var(--content-tertiary)]",
          isError && "text-[var(--system-negative-strong)]",
        )}
      >
        {view.icon}
      </span>
      <span className="min-w-0 max-w-[min(520px,calc(100vw-8rem))] truncate">
        {view.shimmerLabel ? (
          <StreamingShimmerText data-testid="thought-process-loading">
            {view.label}
          </StreamingShimmerText>
        ) : (
          view.label
        )}
      </span>
      {view.riskLevel ? <RiskBadge level={view.riskLevel} /> : null}
      <ChevronRight
        className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
    </button>
  );
}
