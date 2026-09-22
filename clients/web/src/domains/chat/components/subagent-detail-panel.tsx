import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bolt,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { motion, useReducedMotion } from "motion/react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { DetailShell, DetailShellNotice } from "@/components/detail-shell";
import {
  AnimatedMetricCard,
  formatNumber,
} from "@/domains/chat/components/metric-card";
import { StatusBadge } from "@/domains/chat/components/subagent-status-badge";
import { canAddressSubagentDetail } from "@/domains/chat/store-helpers/subagent-detail-addressability";
import type { SubagentEntry } from "@/domains/chat/subagent-store";
import { useSubagentHistory } from "@/domains/chat/hooks/use-subagent-history";
import { subagentTraits } from "@/utils/avatar-subagent";
import { isActiveStatus } from "@/utils/subagent-status";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { DetailPanelStopButton } from "@/components/detail-panel-stop-button";
import { SubagentPhaseTimeline } from "@/domains/chat/components/subagent-phase-timeline";
import {
  deriveStepLabelFromName,
  type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import {
  ToolDetailBody,
  ToolDetailHeaderTitle,
  toolDetailHeaderTitle,
} from "@/domains/chat/components/tool-detail-panel";
import {
  findToolCall,
  useLiveToolCall,
  SNAPSHOT_TOOL_CALL_SOURCE,
  type ToolCallSource,
} from "@/domains/chat/hooks/use-live-tool-call";
import { useSubagentSteps } from "@/domains/chat/subagent-step-projection";
import { useSubagentStepDetails } from "@/domains/chat/subagent-detail-projection";
import { resolveSubagentStepDetail } from "@/domains/chat/utils/subagent-step-detail";
import type { ToolDetailPayload } from "@/stores/viewer-store";
import { useTranslation } from "@/i18n";
import { useOverflows } from "@/hooks/use-overflows";

/**
 * The icon name for a nested step detail — the same glyph its timeline pill
 * shows: a globe for web search, a brain for a thinking segment, otherwise the
 * tool-type icon `deriveStepLabelFromName` resolves (e.g. code brackets for
 * bash). Resolved through the shared `ICON_MAP` so header and pills never drift.
 */
function iconNameForDetail(detail: ToolDetailPayload): IconName {
  if (detail.kind === "web_search") {
    return "globe";
  }
  if (detail.kind === "thinking") {
    return "brain";
  }
  return deriveStepLabelFromName(detail.toolName, detail.input).iconName;
}

/**
 * Leading glyph for the nested-detail header — replaces the subagent avatar: the
 * running indicator while the step is still in flight, otherwise the step's own
 * icon (matching the pill that opened it).
 */
function NestedHeaderGlyph({ detail }: { detail: ToolDetailPayload }) {
  if (detail.status === "running") {
    return (
      <ThreeDotIndicator
        className="shrink-0"
        data-testid="nested-detail-running"
      />
    );
  }
  const Glyph = ICON_MAP[iconNameForDetail(detail)] ?? Bolt;
  return (
    <Glyph
      aria-hidden
      className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
    />
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubagentDetailPanelProps {
  entry: SubagentEntry;
  onClose: () => void;
  onStop?: (subagentId: string) => void;
  onRequestDetail?: (subagentId: string) => void;
  /**
   * Assistant that owns the conversation this subagent was spawned from.
   * Threaded to the step markdown (and the nested tool detail) so workspace
   * file references resolve against the right workspace.
   */
  assistantId?: string | null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubagentDetailPanel({
  entry,
  onClose,
  onStop,
  onRequestDetail,
  assistantId,
}: SubagentDetailPanelProps) {
  const { t } = useTranslation("chat");
  const isRunning = isActiveStatus(entry.status);
  const reduce = useReducedMotion();
  const components = useBundledAvatarComponents();
  // Compute the avatar traits once per subagent instead of hashing the id
  // three separate times in the JSX below.
  const traits = useMemo(
    () => subagentTraits(entry.subagentId),
    [entry.subagentId],
  );
  // The panel re-renders when `entry` changes via the store subscription in
  // chat-content-layout.tsx. The store bumps `entry` identity on every
  // token/status/usage update but keeps `entry.events` reference-stable. Rather
  // than rebuild the whole timeline on each tick, `useSubagentSteps` replays
  // only the events that changed since the last render (append / text-coalesce),
  // and preserves the `steps` array identity when nothing visible changed so the
  // timeline below can bail. The panel renders its own header from `entry`
  // directly, so it needs only the projected `steps`.
  const { steps } = useSubagentSteps(entry.events);

  // Reasoning payloads for clickable thinking pills, keyed by the source text
  // event's id and carrying the full, un-truncated reasoning. Built
  // incrementally (mirrors `useSubagentSteps`): the projector replays only the
  // events that changed since the last render.
  const stepDetails = useSubagentStepDetails(entry.events);

  // Tool pills key on their tool-use id, the identity of the call in this
  // subagent's history, where the nested detail reads it from.
  const toolCallSource = useMemo<ToolCallSource>(
    () => ({ kind: "subagent", subagentId: entry.subagentId }),
    [entry.subagentId],
  );

  // The history those calls live in, kept loaded while the panel shows it.
  const loadHistory = useSubagentHistory(entry, assistantId);

  // Which step's detail (if any) is shown nested inside this panel: a tool
  // call's id or a thinking segment's key, or `null` to show the timeline.
  // Reset on subagent switch via the render-phase block below so a detail
  // opened for one subagent doesn't leak onto the next.
  const [selectedDetailKey, setSelectedDetailKey] = useState<string | null>(
    null,
  );

  // Read the openable targets through refs so the click handler below stays
  // identity-stable while events stream: both change on most streamed events,
  // and a changing handler passed to the memoized `SubagentPhaseRow`s would
  // re-render every row on each event. Synced in a layout effect, so a click
  // after commit always reads the committed values.
  const stepDetailsRef = useRef(stepDetails);
  const historyRef = useRef(entry.history);
  useLayoutEffect(() => {
    stepDetailsRef.current = stepDetails;
    historyRef.current = entry.history;
  }, [stepDetails, entry.history]);
  const handleStepDetailClick = useCallback(
    (key: string) => {
      // A pill always opens: the call from the subagent's history when it is
      // there, otherwise the detail built from the timeline's own events. A
      // missing history (a failed fetch, or one a stream gap dropped) reloads
      // in the background, and the canonical call replaces the fallback when
      // it lands.
      if (historyRef.current === null) {
        void loadHistory();
      }
      if (
        stepDetailsRef.current.has(key) ||
        findToolCall(historyRef.current?.messages ?? [], key)
      ) {
        setSelectedDetailKey(key);
      }
    },
    [loadHistory],
  );

  // Which timeline groups are expanded. Lifted out of `SubagentPhaseTimeline`
  // so the expansion survives the timeline unmounting while a nested tool
  // detail is shown — returning via "Back" restores the same open group. Reset
  // on subagent switch via the render-phase block below.
  const [expandedSectionKeys, setExpandedSectionKeys] = useState<Set<string>>(
    new Set(),
  );

  // Objective collapse/expand. The toggle only appears when the clamped body
  // actually overflows, so short objectives show no affordance.
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  // Measured against the collapsed clamp, and held while expanded so "Show
  // less" stays. Keyed on the subagent as well as the text, so a switch
  // between two subagents with the same objective still re-measures.
  const { ref: objectiveBodyRef, overflows: objectiveOverflows } =
    useOverflows<HTMLParagraphElement>({
      contentKey: `${entry.subagentId}:${entry.objective}`,
      paused: objectiveExpanded,
    });

  // Reset objective collapse state when the subagent changes. The desktop
  // parent reuses this instance across subagent switches (no `key`), so without
  // this an objective expanded for one subagent leaks onto the next, and since
  // the measurement holds while expanded, the new (possibly short) objective
  // would render stale-expanded with a spurious "Show less". Resetting during
  // render (React's "store previous prop" pattern) collapses it before paint
  // (no flash), which resumes the measurement for the new objective.
  const [prevSubagentId, setPrevSubagentId] = useState(entry.subagentId);
  if (prevSubagentId !== entry.subagentId) {
    setPrevSubagentId(entry.subagentId);
    setObjectiveExpanded(false);
    // Switching subagents returns the panel to the timeline view and clears
    // the previous subagent's expanded groups.
    setSelectedDetailKey(null);
    setExpandedSectionKeys(new Set());
  }


  // The panel is where a settled subagent's timeline is fetched: the
  // conversation-load auto-fetch only covers live rows, so opening one of the
  // many terminal rows reconcile materializes is what pays for its detail.
  // Addressability goes through the shared predicate so a stub that knows only
  // its parent conversation (0.11.0+ daemons resolve the child themselves)
  // isn't skipped here while the auto-fetch happily fetches it.
  const canFetchDetail = canAddressSubagentDetail(entry);
  useEffect(() => {
    if (onRequestDetail && canFetchDetail && entry.events.length === 0) {
      onRequestDetail(entry.subagentId);
    }
  }, [entry.subagentId, canFetchDetail, entry.events.length, onRequestDetail]);

  // The selected step's nested detail: the canonical call in this subagent's
  // history merged with the payload built from the timeline's events (see
  // `resolveSubagentStepDetail`). The merge is remade from the live call on
  // every render, so the body reads it as a snapshot rather than re-reading
  // the canonical copy alone.
  const liveToolCall = useLiveToolCall(toolCallSource, selectedDetailKey);
  const activeDetail = resolveSubagentStepDetail(
    liveToolCall,
    selectedDetailKey ? stepDetails.get(selectedDetailKey) : undefined,
  );

  // Returns from a nested step detail to the subagent timeline. Clearing only
  // `selectedDetailKey` preserves `expandedSectionKeys` (and the objective
  // collapse state), so the timeline reopens exactly as the user left it.
  // Shared by the header Back button and the breadcrumb's subagent crumb.
  const handleBack = useCallback(() => setSelectedDetailKey(null), []);

  // The nested step's label — the breadcrumb tail and the header title while a
  // detail is open. Mirrors the main-chat tool detail panel's `activity ||
  // title` precedence.
  const detailTitle = activeDetail ? toolDetailHeaderTitle(activeDetail) : "";
  // The header title tracks the breadcrumb's deepest crumb: the subagent at the
  // timeline, the drilled-into step once a detail is open.
  const headerTitle = activeDetail ? detailTitle : entry.label;
  // A drilled-into tool step gets the shared tool-detail header so it is headed
  // the same way as in the main panel; thinking steps and the timeline keep the
  // plain string title.
  const showToolHeader = Boolean(
    activeDetail && activeDetail.kind !== "thinking",
  );

  return (
    <DetailShell
      headerAbove={
        // Breadcrumb: only shown once a nested step detail is open; the
        // top-level subagent timeline has no breadcrumb. The subagent crumb is
        // a button that returns to the timeline (retaining expanded groups),
        // mirroring the header Back button; the step crumb is the current
        // (deepest) level.
        activeDetail && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
            <Button
              variant="link"
              onClick={handleBack}
              title={entry.label}
              // inline-flex: the `link` variant is `display: inline`, which can't
              // constrain the label for truncation. border-0: the button base
              // carries a 1px transparent border the raw crumb never had, which
              // would grow the breadcrumb row by 2px.
              className="inline-flex min-w-0 shrink border-0 text-left text-[color:var(--content-default)]"
            >
              <Typography
                variant="body-small-default"
                as="span"
                className="min-w-0 truncate"
              >
                {entry.label}
              </Typography>
            </Button>
            <ChevronRight
              className="h-2.5 w-2.5 shrink-0 text-[var(--content-tertiary)]"
              aria-hidden
            />
            <Typography
              variant="body-small-default"
              as="span"
              title={detailTitle}
              className="min-w-0 shrink truncate text-[var(--content-secondary)]"
            >
              {detailTitle}
            </Typography>
          </div>
        )
      }
      icon={
        <>
          {activeDetail && (
            <Button
              variant="outlined"
              iconOnly={<ChevronLeft />}
              onClick={handleBack}
              aria-label={t("subagentDetailPanel.backToTimelineAria")}
              tooltip={t("subagentDetailPanel.backTooltip")}
              className="shrink-0"
            />
          )}
          {activeDetail ? (
            <NestedHeaderGlyph detail={activeDetail} />
          ) : components ? (
            <AvatarRenderer
              components={components}
              bodyShapeId={traits.bodyShape}
              eyeStyleId={traits.eyeStyle}
              colorId={traits.color}
              size={32}
            />
          ) : (
            <div style={{ width: 32, height: 32, flexShrink: 0 }} aria-hidden />
          )}
        </>
      }
      title={showToolHeader ? undefined : headerTitle}
      titleNode={
        showToolHeader && activeDetail ? (
          <ToolDetailHeaderTitle
            detail={activeDetail}
            source={SNAPSHOT_TOOL_CALL_SOURCE}
          />
        ) : undefined
      }
      headerTrailing={<StatusBadge status={entry.status} />}
      headerActions={
        isRunning && onStop ? (
          <DetailPanelStopButton
            onStop={() => onStop(entry.subagentId)}
            ariaLabel={t("subagentDetailPanel.stopSubagentAria")}
          />
        ) : undefined
      }
      closeLabel={t("subagentDetailPanel.closeDetail")}
      onClose={onClose}
    >
      {/* Body: swaps to a step's nested detail when one is selected, keeping
          the header above mounted in both views. */}
      <motion.div
          key={activeDetail ? "detail" : "list"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }
          }
        >
          {activeDetail ? (
            <>
              {/* Navigation back to the timeline lives in the header (Back button)
              and the breadcrumb; this body only renders the step's detail.
              Thinking steps render their reasoning markdown statically, because
              subagent detail is not a live chat-session source; every tool goes
              through `ToolDetailBody`, which picks its renderer. */}
              {activeDetail.kind === "thinking" ? (
                <ChatMarkdownMessage
                  content={activeDetail.thinkingText ?? ""}
                  hardLineBreaks
                  assistantId={assistantId}
                />
              ) : (
                <ToolDetailBody
                  detail={activeDetail}
                  source={SNAPSHOT_TOOL_CALL_SOURCE}
                  assistantId={assistantId}
                />
              )}
            </>
          ) : (
            <>
              {/* Metrics row */}
              <div className="mb-5 grid grid-cols-2 gap-3">
                <AnimatedMetricCard
                  icon={
                    <ArrowDownToLine
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  }
                  target={entry.inputTokens}
                  format={(n) => formatNumber(Math.round(n))}
                  label={t("subagentDetailPanel.input")}
                />
                <AnimatedMetricCard
                  icon={
                    <ArrowUpFromLine
                      className="h-4 w-4 shrink-0"
                      style={{ color: "var(--content-secondary)" }}
                    />
                  }
                  target={entry.outputTokens}
                  format={(n) => formatNumber(Math.round(n))}
                  label={t("subagentDetailPanel.output")}
                />
              </div>

              {/* Objective section */}
              {entry.objective && (
                <div className="mb-5">
                  <Typography
                    variant="body-medium-default"
                    as="h3"
                    className="mb-2 text-[var(--content-emphasised)]"
                  >
                    {t("subagentDetailPanel.objective")}
                  </Typography>
                  <Typography
                    ref={objectiveBodyRef}
                    variant="body-medium-lighter"
                    as="p"
                    // When expanded the text becomes its own scroll container, so
                    // make it a focusable, labelled region — otherwise keyboard
                    // users can't reach the overflowed objective content.
                    tabIndex={objectiveExpanded ? 0 : undefined}
                    role={objectiveExpanded ? "region" : undefined}
                    aria-label={objectiveExpanded ? t("subagentDetailPanel.objective") : undefined}
                    className={`whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)] ${
                      objectiveExpanded
                        ? "max-h-[280px] overflow-y-auto"
                        : "line-clamp-5"
                    }`}
                  >
                    {entry.objective}
                  </Typography>
                  {objectiveOverflows && (
                    <Button
                      variant="link"
                      onClick={() => setObjectiveExpanded((prev) => !prev)}
                      aria-expanded={objectiveExpanded}
                      rightIcon={
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${
                            objectiveExpanded ? "rotate-180" : ""
                          }`}
                          aria-hidden
                        />
                      }
                      // no-underline: this is a disclosure toggle, not a link.
                      // border-0: see the breadcrumb crumb above.
                      className="mt-1.5 inline-flex gap-1 border-0 text-[color:var(--content-secondary)] hover:text-[color:var(--content-default)] hover:no-underline"
                    >
                      <Typography variant="label-small-default">
                        {objectiveExpanded ? t("subagentDetailPanel.showLess") : t("subagentDetailPanel.showMore")}
                      </Typography>
                    </Button>
                  )}
                  <div className="mt-5 h-px w-full bg-[var(--border-hover)]" />
                </div>
              )}

              {/* Timeline section */}
              <div>
                <Typography
                  variant="title-medium"
                  as="h3"
                  className="mb-4 text-[var(--content-emphasised)]"
                >
                  {t("subagentDetailPanel.timeline")}
                </Typography>
                {/*
                 * Key by subagent id so the timeline remounts on subagent switch,
                 * resetting the expand/collapse state it holds. The drawer keeps this
                 * component mounted across switches, so without a per-subagent reset
                 * an expanded phase would leak its expanded state onto the next
                 * subagent's same-positioned phase.
                 */}
                {/*
                 * Gate the empty state on the RAW `entry.events`, not on the
                 * projected `steps`. `computeSubagentSteps` can intentionally
                 * DROP events (e.g. a `tool_result` with no preceding in-flight
                 * `tool_call`), so `entry.events` can be non-empty while `steps`
                 * is empty. Gating on steps would show a false "No events yet"
                 * AND — because `entry.events.length !== 0` — the detail-refetch
                 * effect above wouldn't fire to recover. When the store has events
                 * we render the timeline (which returns null for zero steps, an
                 * acceptable no-op).
                 */}
                {entry.events.length > 0 ? (
                  <SubagentPhaseTimeline
                    key={entry.subagentId}
                    steps={steps}
                    expandedKeys={expandedSectionKeys}
                    onExpandedKeysChange={setExpandedSectionKeys}
                    onStepDetailClick={handleStepDetailClick}
                    // Keeps the last phase's node pulsing while the subagent is
                    // still active but its last phase has settled.
                    isRunning={isRunning}
                  />
                ) : (
                  <DetailShellNotice>
                    {t("subagentDetailPanel.noEventsYet")}
                  </DetailShellNotice>
                )}
              </div>
            </>
          )}
        </motion.div>
    </DetailShell>
  );
}
