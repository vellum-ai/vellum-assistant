import { Brain } from "lucide-react";
import { useMemo, useState } from "react";

import { showContextWindowIndicator } from "@/utils/composer-settings";
import { isPointerCoarse } from "@/utils/pointer";
import {
  BottomSheet,
  Button,
  ProgressBar,
  Tooltip,
  TooltipProvider,
} from "@vellumai/design-library";

export interface ContextWindowUsage {
  tokens: number;
  maxTokens: number | null;
  fillRatio: number | null;
}

interface ContextWindowIndicatorProps {
  usage: ContextWindowUsage | null;
  assistantName: string | null;
  onClearContext?: () => void;
}

const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function resolveRingColor(ratio: number): string {
  if (ratio >= 0.8) {
    return "var(--system-negative-strong)";
  }
  if (ratio >= 0.6) {
    return "var(--system-mid-strong)";
  }
  // Neutral below the warning thresholds, matching macOS VContextWindowIndicator.
  // Not --system-positive-strong: velvet restyles that token to its pink accent.
  return "var(--content-tertiary)";
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }
  return `${count}`;
}

/**
 * The ring's accessible name. Both presentations and the sheet's gauge share
 * it, so a screen reader hears the same thing whichever one renders.
 */
function ringLabel(percentage: number): string {
  return `Context window ${percentage}% full`;
}

/**
 * The ring glyph only. Deliberately carries no name, role, or tab stop: each
 * branch below wraps it in exactly one focusable, labelled element, and a
 * labelled ring nested inside a labelled trigger would announce twice and
 * take two tab stops.
 */
function CircularRing({
  ringColor,
  dashOffset,
}: {
  ringColor: string;
  dashOffset: number;
}) {
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
      className="block"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="var(--content-tertiary)"
        strokeWidth={RING_STROKE}
        opacity={0.2}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke={ringColor}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        style={{
          transition: "stroke-dashoffset 250ms ease-out, stroke 250ms ease-out",
        }}
      />
    </svg>
  );
}

function PointerTooltipContent({
  percentage,
  ringColor,
  tokens,
  maxTokens,
  assistantDisplayName,
}: {
  percentage: number;
  ringColor: string;
  tokens: number;
  maxTokens: number | null;
  assistantDisplayName: string;
}) {
  return (
    <>
      <div className="text-body-small-default text-[var(--content-secondary)]">
        Context window:
      </div>
      <div className="text-body-medium-default" style={{ color: ringColor }}>
        {percentage}% full
      </div>
      {maxTokens != null && (
        <div className="text-body-small-default text-[var(--content-secondary)]">
          {formatTokens(tokens)} / {formatTokens(maxTokens)} tokens used
        </div>
      )}
      <div className="text-label-medium-default leading-tight text-[var(--content-tertiary)]">
        {assistantDisplayName} automatically
        <br />
        compacts its context.
      </div>
    </>
  );
}

function TouchSheetContent({
  percentage,
  ringColor,
  ratio,
  tokens,
  maxTokens,
  assistantDisplayName,
  onClearContext,
  onClose,
}: {
  percentage: number;
  ringColor: string;
  ratio: number;
  tokens: number;
  maxTokens: number | null;
  assistantDisplayName: string;
  onClearContext?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-6">
        <span
          aria-hidden="true"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-active)]"
        >
          <Brain className="h-7 w-7 text-[var(--primary-base)]" />
        </span>

        <BottomSheet.Title className="justify-center">
          Context Window
        </BottomSheet.Title>

        <div className="w-full px-2">
          <ProgressBar
            value={ratio}
            height={16}
            fillColor={ringColor}
            className="bg-[color-mix(in_srgb,var(--content-tertiary)_20%,transparent)]"
            aria-label={ringLabel(percentage)}
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <span className="text-body-large-default text-[var(--content-default)]">
            {percentage}% full
            {maxTokens != null && (
              <>
                {" "}
                <span className="text-[var(--content-tertiary)]">•</span>{" "}
                {formatTokens(tokens)} / {formatTokens(maxTokens)} tokens used
              </>
            )}
          </span>
          <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {assistantDisplayName} automatically compacts context
          </span>
        </div>
      </div>

      {onClearContext && (
        <BottomSheet.Footer className="justify-center pt-6">
          <Button
            variant="outlined"
            fullWidth
            onClick={() => {
              onClearContext();
              onClose();
            }}
          >
            Clear Context
          </Button>
        </BottomSheet.Footer>
      )}
    </>
  );
}

/**
 * Composer ring showing how full the context window is.
 *
 * Opt-in via Settings → General → Preferences ("Show context window usage");
 * hidden by default. Gating lives here rather than at the mount site so every
 * caller inherits the preference.
 */
export function ContextWindowIndicator({
  usage,
  assistantName,
  onClearContext,
}: ContextWindowIndicatorProps) {
  const assistantDisplayName = assistantName?.trim() || "Your assistant";
  const enabled = showContextWindowIndicator.useValue();
  // Input capability, not window size. The other presentation is a
  // hover-revealed tooltip, and Radix tooltips never open on touch, so a
  // coarse pointer needs the sheet at any width: a tablet and a phone in
  // landscape are both roomy and both thumb-driven. Read once, so a
  // streaming token count cannot flip the presentation mid-turn and remount
  // an open sheet.
  const isTouch = useMemo(() => isPointerCoarse(), []);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!enabled || !usage || usage.fillRatio == null) {
    return null;
  }

  const ratio = Math.min(Math.max(usage.fillRatio, 0), 1);
  const percentage = Math.round(ratio * 100);
  const ringColor = resolveRingColor(ratio);
  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
  const { tokens, maxTokens } = usage;

  if (isTouch) {
    return (
      <BottomSheet.Root open={sheetOpen} onOpenChange={setSheetOpen}>
        <BottomSheet.Trigger asChild>
          <button
            type="button"
            className="relative flex items-center px-1.5"
            aria-label={ringLabel(percentage)}
          >
            <CircularRing ringColor={ringColor} dashOffset={dashOffset} />
          </button>
        </BottomSheet.Trigger>
        <BottomSheet.Content
          aria-describedby={undefined}
          className="max-h-[85dvh]"
        >
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Context Window</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="px-2 pt-8 pb-8">
            <TouchSheetContent
              percentage={percentage}
              ringColor={ringColor}
              ratio={ratio}
              tokens={tokens}
              maxTokens={maxTokens}
              assistantDisplayName={assistantDisplayName}
              onClearContext={onClearContext}
              onClose={() => setSheetOpen(false)}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  // Own the provider rather than relying on the app-level one in
  // `providers.tsx`, so the ring also works in isolation (tests, Storybook).
  // The design library's own `Tooltip` convenience wrapper does the same, and
  // documents that a nested provider scopes its subtree with matching
  // defaults.
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger
          type="button"
          aria-label={ringLabel(percentage)}
          className="relative flex items-center rounded-full px-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary-base)]"
        >
          <CircularRing ringColor={ringColor} dashOffset={dashOffset} />
        </Tooltip.Trigger>
        <Tooltip.Content
          side="top"
          className="flex flex-col gap-2 bg-[var(--surface-lift)] p-3 text-left"
        >
          <PointerTooltipContent
            percentage={percentage}
            ringColor={ringColor}
            tokens={tokens}
            maxTokens={maxTokens}
            assistantDisplayName={assistantDisplayName}
          />
        </Tooltip.Content>
      </Tooltip.Root>
    </TooltipProvider>
  );
}
