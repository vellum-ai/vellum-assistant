// Generic, registry-driven "active X" chat overlay shared by the four
// background-process surfaces (subagent / workflow / ACP run / background task).
// Reproduces the bespoke `ActiveWorkflowsOverlay` shape — `ActiveOverlayShell`
// chrome + a per-kind pill + one `InlineProcessCard` per active id — but reads
// everything it needs from a `BackgroundProcessDescriptor` instead of hardwiring
// a single kind's pill, copy, and handlers.
//
// `ids` are passed in (owned by the registry/caller, projected from the kind's
// store) rather than read here, so this component is store-agnostic and trivial
// to test with a fake descriptor.

import { ChevronDown, ChevronUp } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { ActiveOverlayShell } from "@/domains/chat/components/active-overlay-shell";
import { ChatPill } from "@/domains/chat/components/chat-pill";
import { InlineProcessCardRow } from "@/domains/chat/process-registry/inline-process-card-row";
import { StackedChipsPill } from "@/domains/chat/process-registry/stacked-chips-pill";
import type { BackgroundProcessDescriptor } from "@/domains/chat/process-registry/types";

export interface ActiveProcessOverlayProps {
  /** The kind-specific contract supplying pill, copy, card projection, handlers. */
  descriptor: BackgroundProcessDescriptor;
  /** Ids of the currently-active processes for this kind. */
  ids: string[];
}

/**
 * One inline-card row inside the expanded dropdown. Renders through the shared
 * {@link InlineProcessCardRow} (so the summary fetch, null short-circuit, and
 * custom count slot all live in one place), wiring the descriptor's own
 * `onOpenDetail` / `onStop` handlers.
 *
 * Opening drills into the detail panel and dismisses the dropdown so the two
 * layers stop competing for column width; stopping keeps it open
 * (`InlineProcessCard` gates the stop button on `state === "loading"`).
 */
function OverlayRow({
  descriptor,
  id,
  onClose,
}: {
  descriptor: BackgroundProcessDescriptor;
  id: string;
  onClose: () => void;
}) {
  return (
    <InlineProcessCardRow
      descriptor={descriptor}
      id={id}
      onOpen={() => {
        descriptor.onOpenDetail(id);
        onClose();
      }}
      onStop={descriptor.onStop && (() => descriptor.onStop!(id))}
    />
  );
}

/**
 * Registry-driven version of the bespoke "active X" overlays. Self-gating:
 * renders nothing when there are no active ids.
 */
export function ActiveProcessOverlay({
  descriptor,
  ids,
}: ActiveProcessOverlayProps) {
  if (ids.length === 0) return null;

  const { pill } = descriptor;

  return (
    <ActiveOverlayShell
      testId={`active-${descriptor.kind}-overlay`}
      title={descriptor.overlayTitle(ids.length)}
      renderPill={({ expanded, onToggle }) =>
        pill.variant === "stacked" ? (
          <StackedChipsPill
            ids={ids}
            renderChip={pill.renderChip}
            max={pill.max}
            expanded={expanded}
            onToggle={onToggle}
            ariaLabel={descriptor.pillAriaLabel(ids.length)}
          />
        ) : (
          <ChatPill
            onClick={onToggle}
            ariaLabel={descriptor.pillAriaLabel(ids.length)}
            ariaExpanded={expanded}
            size="compact"
          >
            {/* pointer-events-none so the ChatPill button owns clicks + cursor —
                clicking anywhere toggles. */}
            <span className="pointer-events-none inline-flex items-center gap-1.5">
              {pill.glyph}
              <Typography
                variant="body-small-default"
                className="text-[var(--content-emphasised)]"
              >
                {ids.length}
              </Typography>
              {expanded ? (
                <ChevronUp
                  className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
                  aria-hidden
                />
              ) : (
                <ChevronDown
                  className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
                  aria-hidden
                />
              )}
            </span>
          </ChatPill>
        )
      }
    >
      {({ close }) =>
        ids.map((id) => (
          <OverlayRow
            key={id}
            descriptor={descriptor}
            id={id}
            onClose={close}
          />
        ))
      }
    </ActiveOverlayShell>
  );
}
