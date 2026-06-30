import type { ComponentType, ReactNode } from "react";

import type { ToolProgressCardState } from "@/domains/chat/components/tool-progress-card/tool-progress-card-shell";

/**
 * The four background-process surfaces that share the same inline-card +
 * detail-panel + overlay-pill UI shape. Each kind has its own store and
 * projection, but the *presentation* is identical modulo the axes captured by
 * {@link BackgroundProcessDescriptor}.
 */
export type ProcessKind =
  | "subagent"
  | "workflow"
  | "acp-run"
  | "background-task";

/**
 * Pre-projected summary used to render a process's inline card.
 *
 * Returned by {@link BackgroundProcessDescriptor.useCardSummary}; a `null`
 * return means the process has no card-worthy state right now (e.g. it hasn't
 * started or has been cleared).
 */
export interface CardSummary {
  /** Drives the card shell's leading status indicator. */
  state: ToolProgressCardState;
  /** Primary line — the human-readable name of the process. */
  title: string;
  /** Secondary line — a short status/description string. */
  info: string;
  /**
   * Optional pre-formatted noun string describing the unit count, e.g.
   * `"3 agents"` or `"5 steps"`. Already includes the noun and is rendered
   * verbatim. Omitted for kinds that have no meaningful count
   * (`background-task`).
   */
  count?: string;
}

/**
 * How a kind renders its overlay pill — the floating affordance that shows the
 * number of active processes and opens the overlay.
 *
 * - `stacked` — renders up to `max` per-process chips side by side via
 *   `renderChip`. Used by kinds whose individual processes have a meaningful
 *   visual identity (e.g. subagent avatars).
 * - `count` — renders a single static `glyph` next to the count. Used by kinds
 *   whose processes are visually interchangeable.
 */
export type ProcessPillConfig<Id extends string = string> =
  | { variant: "stacked"; renderChip: (id: Id) => ReactNode; max: number }
  | { variant: "count"; glyph: ReactNode };

/**
 * The single contract that genericizes a background-process UI surface.
 *
 * Each axis exists because it maps to a *real* divergence across the four
 * kinds — none is speculative:
 *
 * - `kind` — discriminates the descriptor in the registry.
 * - `useActiveIds` — each kind owns a different store, so the source of the
 *   currently-active id list differs per kind.
 * - `useCardSummary` — projection from a kind's store state into the shared
 *   {@link CardSummary} shape; the projection logic is per-kind.
 * - `renderCardLeading` — the leading slot of the inline card differs (subagent
 *   avatar vs. workflow/acp/background-task icon).
 * - `pill` — overlay-pill presentation diverges between stacked chips and a
 *   single count glyph (see {@link ProcessPillConfig}).
 * - `overlayTitle` / `pillAriaLabel` — the count-dependent copy differs per
 *   kind ("3 agents" vs. "3 workflows" vs. "3 tasks").
 * - `openCardAriaLabel` — the static aria label for the inline card's open
 *   affordance differs per kind.
 * - `onOpenDetail` — opening a process's detail panel routes through per-kind
 *   navigation/selection logic.
 * - `onStop` — only some kinds support stopping an in-flight process; omitted
 *   when the kind has no stop action.
 * - `DetailPanel` — each kind renders a different detail UI.
 */
export interface BackgroundProcessDescriptor<Id extends string = string> {
  /** Discriminant used to look the descriptor up in the registry. */
  kind: ProcessKind;
  /** Hook returning the ids of the currently-active processes for this kind. */
  useActiveIds: () => Id[];
  /**
   * Hook projecting a single process's store state into a {@link CardSummary},
   * or `null` when the process has no card-worthy state.
   */
  useCardSummary: (id: Id) => CardSummary | null;
  /** Renders the leading slot of the inline card for a single process. */
  renderCardLeading: (id: Id) => ReactNode;
  /** Overlay-pill presentation config. */
  pill: ProcessPillConfig<Id>;
  /** Count-dependent overlay title copy, e.g. `(3) => "3 agents"`. */
  overlayTitle: (count: number) => string;
  /** Count-dependent aria label for the overlay pill. */
  pillAriaLabel: (count: number) => string;
  /** Static aria label for the inline card's open affordance. */
  openCardAriaLabel: string;
  /** Opens the detail panel for a single process. */
  onOpenDetail: (id: Id) => void;
  /** Stops an in-flight process; omitted for kinds without a stop action. */
  onStop?: (id: Id) => void;
  /** Detail-panel component rendered for a single process. */
  DetailPanel: ComponentType<{ id: Id; onClose: () => void }>;
}
