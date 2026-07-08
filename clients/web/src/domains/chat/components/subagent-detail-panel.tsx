
import {
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpFromLine,
    Bolt,
    ChevronDown,
    ChevronRight,
    X,
} from "lucide-react";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { motion, useReducedMotion } from "motion/react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import {
    AnimatedMetricCard,
    formatNumber,
} from "@/domains/chat/components/metric-card";
import { StatusBadge } from "@/domains/chat/components/subagent-status-badge";
import type { SubagentEntry } from "@/domains/chat/subagent-store";
import { subagentTraits } from "@/utils/avatar-subagent";
import { isActiveStatus } from "@/utils/subagent-status";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { DetailPanelStopButton } from "@/domains/chat/components/detail-panel-stop-button";
import { SubagentPhaseTimeline } from "@/domains/chat/components/subagent-phase-timeline";
import {
    deriveStepLabelFromName,
    type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { ToolDetailBody } from "@/domains/chat/components/tool-detail-panel";
import { WebFetchDetailView } from "@/domains/chat/components/web-fetch/web-fetch-detail-view";
import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import { useSubagentSteps } from "@/domains/chat/subagent-step-projection";
import { useSubagentStepDetails } from "@/domains/chat/subagent-detail-projection";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * The icon name for a nested step detail — the same glyph its timeline pill
 * shows: a globe for web search, a brain for a thinking segment, otherwise the
 * tool-type icon `deriveStepLabelFromName` resolves (e.g. code brackets for
 * bash). Resolved through the shared `ICON_MAP` so header and pills never drift.
 */
function iconNameForDetail(detail: ToolDetailPayload): IconName {
  if (detail.kind === "web_search") return "globe";
  if (detail.kind === "thinking") return "brain";
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
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubagentDetailPanel({
  entry,
  onClose,
  onStop,
  onRequestDetail,
}: SubagentDetailPanelProps) {
  const isRunning = isActiveStatus(entry.status);
  const reduce = useReducedMotion();
  const components = useBundledAvatarComponents();
  // Compute the avatar traits once per subagent instead of hashing the id
  // three separate times in the JSX below.
  const traits = useMemo(() => subagentTraits(entry.subagentId), [entry.subagentId]);
  // The panel re-renders when `entry` changes via the store subscription in
  // chat-content-layout.tsx. The store bumps `entry` identity on every
  // token/status/usage update but keeps `entry.events` reference-stable. Rather
  // than rebuild the whole timeline on each tick, `useSubagentSteps` replays
  // only the events that changed since the last render (append / text-coalesce),
  // and preserves the `steps` array identity when nothing visible changed so the
  // timeline below can bail. The panel renders its own header from `entry`
  // directly, so it needs only the projected `steps`.
  const { steps } = useSubagentSteps(entry.events);

  // `toolCallId`-keyed map of nested tool-detail payloads, used to swap the
  // panel body to a tool's input/output when its timeline pill is clicked —
  // without ever touching the global viewer-store / main view.
  //
  // Detail payloads for clickable timeline steps, keyed by the id a pill emits.
  // Tool steps key on their `toolUseId` (present for both live streaming events
  // and reloaded/history subagents hydrated via `onRequestDetail` from
  // `GET /subagents/:id`, which emits the tool id + raw input that
  // `mapDetailEvents` carries through); thinking/text steps key on the source
  // event id and carry the full, un-truncated reasoning. Steps with no entry
  // here render as non-clickable pills — a graceful fallback, not an error.
  //
  // Built incrementally (mirrors `useSubagentSteps`): the projector replays only
  // the events that changed since the last render through the shared
  // `applyDetailEvent` reducer, with an O(n) full-rebuild fallback. This map is
  // read lazily (only on pill click), so the win is avoiding the O(n) re-walk
  // per streamed event, not re-render avoidance.
  const stepDetails = useSubagentStepDetails(entry.events);

  // Which step's detail (if any) is shown nested inside this panel — the key
  // into `stepDetails` (a tool call or a thinking segment), or `null` to show
  // the timeline. Reset on subagent switch via the render-phase block below so
  // a detail opened for one subagent doesn't leak onto the next.
  const [selectedDetailKey, setSelectedDetailKey] = useState<string | null>(
    null,
  );

  // Read `stepDetails` through a ref so the click handler below can stay
  // identity-stable across `entry.events` changes. `stepDetails` is rebuilt
  // (new Map identity) on most streamed events, so closing over it directly
  // would change the handler identity every tick — which, passed down to the
  // now-memoized `SubagentPhaseRow`s, would re-render every row on each event.
  // The ref is assigned during render (not in an effect) so the handler always
  // sees the latest map without listing it as a dependency.
  const stepDetailsRef = useRef(stepDetails);
  // eslint-disable-next-line react-hooks/refs -- render-phase sync so the stable handler below reads the latest map
  stepDetailsRef.current = stepDetails;
  const handleStepDetailClick = useCallback((key: string) => {
    if (stepDetailsRef.current.has(key)) setSelectedDetailKey(key);
  }, []);

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
  const [objectiveOverflows, setObjectiveOverflows] = useState(false);
  const objectiveBodyRef = useRef<HTMLParagraphElement>(null);

  // Reset objective collapse state when the subagent changes. The desktop
  // parent reuses this instance across subagent switches (no `key`), so without
  // this an objective expanded for one subagent leaks onto the next — and since
  // the measurement effect below early-returns while `objectiveExpanded` is
  // true, the new (possibly short) objective would render stale-expanded with a
  // spurious "Show less" and never re-measure. Resetting during render (React's
  // "store previous prop" pattern) clears both flags before paint (no flash);
  // clearing `objectiveOverflows` lets the effect re-measure from a clean state.
  const [prevSubagentId, setPrevSubagentId] = useState(entry.subagentId);
  if (prevSubagentId !== entry.subagentId) {
    setPrevSubagentId(entry.subagentId);
    setObjectiveExpanded(false);
    setObjectiveOverflows(false);
    // Switching subagents returns the panel to the timeline view and clears
    // the previous subagent's expanded groups.
    setSelectedDetailKey(null);
    setExpandedSectionKeys(new Set());
  }

  // Measure overflow against the collapsed clamp. While collapsed the clamp is
  // the source of truth, so `scrollHeight` exceeds `clientHeight` only when the
  // body is taller than the visible 5 lines. Skip measuring while expanded
  // (the clamp is removed, which would otherwise report no overflow) so the
  // "Show less" affordance stays visible.
  //
  // Depend on `entry.subagentId` too: the render-phase reset above forces
  // `objectiveOverflows` to `false` on a subagent switch, so the effect must
  // re-run to recompute it. Without the id in the deps a switch between two
  // subagents whose objective text is byte-identical changes neither
  // `entry.objective` nor `objectiveExpanded`, the effect skips, and the
  // toggle would stay incorrectly hidden for an overflowing objective.
  useLayoutEffect(() => {
    if (objectiveExpanded) {
      return;
    }
    const node = objectiveBodyRef.current;
    if (!node) {
      return;
    }
    setObjectiveOverflows(node.scrollHeight > node.clientHeight);
  }, [entry.subagentId, entry.objective, objectiveExpanded]);

  useEffect(() => {
    if (onRequestDetail && entry.conversationId && entry.events.length === 0) {
      onRequestDetail(entry.subagentId);
    }
  }, [entry.subagentId, entry.conversationId, entry.events.length, onRequestDetail]);

  // The selected tool's nested payload, or `undefined` when nothing is selected
  // or the id has no payload (defensive — fall back to the timeline view).
  const activeDetail = selectedDetailKey
    ? stepDetails.get(selectedDetailKey)
    : undefined;

  // Returns from a nested step detail to the subagent timeline. Clearing only
  // `selectedDetailKey` preserves `expandedSectionKeys` (and the objective
  // collapse state), so the timeline reopens exactly as the user left it.
  // Shared by the header Back button and the breadcrumb's subagent crumb.
  const handleBack = useCallback(() => setSelectedDetailKey(null), []);

  // The nested step's label — the breadcrumb tail and the header title while a
  // detail is open. Mirrors the main-chat tool detail panel's `activity ||
  // title` precedence.
  const detailTitle = activeDetail
    ? activeDetail.activity || activeDetail.title
    : "";
  // The header title tracks the breadcrumb's deepest crumb: the subagent at the
  // timeline, the drilled-into step once a detail is open.
  const headerTitle = activeDetail ? detailTitle : entry.label;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Breadcrumb — only shown once a nested step detail is open; the
          top-level subagent timeline has no breadcrumb. The subagent crumb is a
          button that returns to the timeline (retaining expanded groups),
          mirroring the header Back button; the step crumb is the current
          (deepest) level. */}
      {activeDetail && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-hover)] px-5 py-3">
          <button
            type="button"
            onClick={handleBack}
            title={entry.label}
            className="min-w-0 shrink cursor-pointer truncate text-left text-[var(--content-default)] hover:underline"
          >
            <Typography variant="body-small-default" as="span">
              {entry.label}
            </Typography>
          </button>
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
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-hover)] px-5 py-4">
        {activeDetail && (
          <Button
            variant="outlined"
            iconOnly={<ArrowLeft />}
            onClick={handleBack}
            aria-label="Back to timeline"
            tooltip="Back"
            className="shrink-0 rounded-lg"
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
        <Typography
          variant="title-medium"
          title={headerTitle}
          // leading-snug: title-medium is line-height:1, so truncate clips the descenders.
          className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
        >
          {headerTitle}
        </Typography>
        <StatusBadge status={entry.status} />
        <span className="flex-1" />
        {isRunning && onStop && (
          <DetailPanelStopButton
            onStop={() => onStop(entry.subagentId)}
            ariaLabel="Stop subagent"
          />
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close subagent detail"
          tooltip="Close"
          className="shrink-0 rounded-lg"
        />
      </div>

      {/* Scrollable body — swaps to a step's nested detail when one is selected,
          keeping the header above mounted in both views. */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
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
              Thinking steps render their full reasoning markdown statically
              (subagent detail isn't a live chat-session source); web_search
              steps render their query + source links; web_fetch gets a
              result-shaped view; other tools fall back to the shared
              technical-details/output body. */}
              {activeDetail.kind === "thinking" ? (
                <ChatMarkdownMessage
                  content={activeDetail.thinkingText ?? ""}
                  hardLineBreaks
                />
              ) : activeDetail.kind === "web_search" &&
                activeDetail.status !== "error" ? (
                // A successful search shows query + sources; a FAILED one falls
                // through to `ToolDetailBody`, which renders its full, untruncated
                // error in the Output section — parity with a failed tool.
                <WebSearchDetailView detail={activeDetail} />
              ) : activeDetail.toolName === "web_fetch" ? (
                <WebFetchDetailView detail={activeDetail} />
              ) : (
                <ToolDetailBody
                  detail={activeDetail}
                  showTechnicalDetailsLabel={false}
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
                  label="Input"
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
                  label="Output"
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
                    Objective
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
                    aria-label={objectiveExpanded ? "Objective" : undefined}
                    className={`whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)] ${
                      objectiveExpanded
                        ? "max-h-[280px] overflow-y-auto"
                        : "line-clamp-5"
                    }`}
                  >
                    {entry.objective}
                  </Typography>
                  {objectiveOverflows && (
                    <button
                      type="button"
                      onClick={() => setObjectiveExpanded((prev) => !prev)}
                      className="mt-1.5 flex cursor-pointer items-center gap-1 text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
                    >
                      <Typography variant="label-small-default">
                        {objectiveExpanded ? "Show less" : "Show more"}
                      </Typography>
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                          objectiveExpanded ? "rotate-180" : ""
                        }`}
                        aria-hidden
                      />
                    </button>
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
                  Timeline
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
                  <Typography
                    variant="body-small-default"
                    className="py-4 text-center text-[var(--content-tertiary)]"
                  >
                    No events yet
                  </Typography>
                )}
              </div>
            </>
          )}
        </motion.div>
      </div>
    </div>
  );
}
