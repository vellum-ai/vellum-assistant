/**
 * Shared builder for guardian approval card seed content blocks.
 *
 * Both access-request and tool-approval notifications render a Surface card
 * with Approve/Reject buttons in the Vellum in-app channel. This module
 * provides the shared construction logic so each notification type only
 * supplies its domain-specific data (title, subtitle, metadata, etc.)
 * without duplicating the card structure or action wiring.
 *
 * The `[ui_surface, text]` block pair is described by {@link ApprovalCardBlockSchema}
 * so the builder returns a schema-derived type rather than `unknown[]`: the card
 * `data` composes the canonical {@link CardSurfaceDataSchema} and actions reuse
 * the canonical {@link SurfaceActionSchema}. Actions use the
 * `apr:<requestId>:<action>` callback format consumed by
 * `surface-action-routes.ts` → `processGuardianDecision`.
 */

import { z } from "zod";

import {
  type SurfaceAction,
  SurfaceActionSchema,
} from "../api/events/ui-surface-show.js";
import {
  type CardSurfaceData,
  CardSurfaceDataSchema,
} from "../daemon/message-types/surfaces.js";

// ── Seed content block schema ─────────────────────────────────────────────────

/**
 * The interactive `ui_surface` card block clients render via
 * `SurfaceRouter → CardSurface`. `data` is the canonical card surface data;
 * `actions` reuse the canonical surface action schema.
 */
export const ApprovalCardSurfaceBlockSchema = z.object({
  type: z.literal("ui_surface"),
  surfaceId: z.string(),
  surfaceType: z.literal("card"),
  title: z.string(),
  data: CardSurfaceDataSchema,
  actions: z.array(SurfaceActionSchema).optional(),
});

/**
 * The plain-text fallback block, flagged so the display projector
 * (`renderHistoryContent`) keeps it in flat `.text` but omits it from the
 * rendered `contentBlocks` — without it a surface-capable client would render
 * the card AND a duplicate text line.
 */
export const ApprovalCardFallbackBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  _surfaceFallback: z.literal(true),
});

/** The `[ui_surface, text]` seed block pair produced for a guardian card. */
export const ApprovalCardBlockSchema = z.discriminatedUnion("type", [
  ApprovalCardSurfaceBlockSchema,
  ApprovalCardFallbackBlockSchema,
]);

export type ApprovalCardSurfaceBlock = z.infer<
  typeof ApprovalCardSurfaceBlockSchema
>;
export type ApprovalCardFallbackBlock = z.infer<
  typeof ApprovalCardFallbackBlockSchema
>;
export type ApprovalCardBlock = z.infer<typeof ApprovalCardBlockSchema>;

// ── Public types ────────────────────────────────────────────────────────────

/** A card action option resolved from the request's domain (id + label + style). */
export interface ApprovalCardActionOption {
  /** Canonical action id — becomes the `apr:<requestId>:<id>` callback. */
  id: string;
  label: string;
  style?: SurfaceAction["style"];
}

export interface ApprovalCardParams {
  /** Prefix for `surfaceId` — combined with `requestId` to form e.g. "access-request-abc123". */
  surfaceIdPrefix: string;
  /** Top-level card title shown in the surface header (e.g. "Access Request", "Tool approval"). */
  cardTitle: string;
  /**
   * Primary line inside the card — the subject of the decision: the
   * requester's display name for access requests, the tool name for tool
   * approvals.
   */
  primaryLine: string;
  /** Secondary line below the primary line (e.g. "Requesting access to the assistant"). */
  subtitle: string;
  /** Markdown body — blockquotes, warnings, links, etc. */
  body: string;
  /** Key-value metadata grid rendered below the body. */
  metadata: Array<{ label: string; value: string }>;
  /** When present, action buttons are wired with `apr:<requestId>:*` action IDs. */
  requestId?: string;
  /**
   * Domain-specific action set (e.g. the signal-driven introduction-card
   * actions). When absent, the generic Approve/Reject pair is rendered.
   */
  actions?: ApprovalCardActionOption[];
  /** Plain-text content for the fallback `text` block. */
  fallbackText: string;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build a `[ui_surface, text]` block pair for a guardian approval notification.
 *
 * The `ui_surface` block renders as a card with Approve/Reject buttons in
 * clients that support Surface rendering. The `text` block is the card's
 * plain-text fallback — it feeds the model, search indexing, CLI display, and
 * channel replies, which read it as ordinary text.
 */
export function buildApprovalCardBlocks(
  params: ApprovalCardParams,
): ApprovalCardBlock[] {
  const {
    surfaceIdPrefix,
    cardTitle,
    primaryLine,
    subtitle,
    body,
    metadata,
    requestId,
    fallbackText,
  } = params;

  const actionOptions: ApprovalCardActionOption[] = params.actions ?? [
    { id: "approve_once", label: "Approve", style: "primary" },
    { id: "reject", label: "Reject", style: "destructive" },
  ];

  const actions: SurfaceAction[] | undefined = requestId
    ? actionOptions.map((option) => ({
        id: `apr:${requestId}:${option.id}`,
        label: option.label,
        ...(option.style ? { style: option.style } : {}),
      }))
    : undefined;

  const data: CardSurfaceData = {
    title: primaryLine,
    subtitle,
    body,
    metadata,
  };

  const surfaceBlock: ApprovalCardSurfaceBlock = {
    type: "ui_surface",
    surfaceId: `${surfaceIdPrefix}-${requestId ?? "unknown"}`,
    surfaceType: "card",
    title: cardTitle,
    data,
    ...(actions ? { actions } : {}),
  };

  const textBlock: ApprovalCardFallbackBlock = {
    type: "text",
    text: fallbackText,
    _surfaceFallback: true,
  };

  return [surfaceBlock, textBlock];
}
