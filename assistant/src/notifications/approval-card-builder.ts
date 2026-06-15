/**
 * Shared builder for guardian approval card seed content blocks.
 *
 * Both access-request and tool-approval notifications render a Surface card
 * with Approve/Reject buttons in the Vellum in-app channel. This module
 * provides the shared construction logic so each notification type only
 * supplies its domain-specific data (title, subtitle, metadata, etc.)
 * without duplicating the card structure or action wiring.
 *
 * The card data shape matches `CardSurfaceData` from
 * `daemon/message-types/surfaces.ts`: `{ title, subtitle, body, metadata }`.
 * Actions use the canonical `apr:<requestId>:<action>` callback format
 * consumed by `surface-action-routes.ts` → `processGuardianDecision`.
 */

// ── Public types ────────────────────────────────────────────────────────────

export interface ApprovalCardParams {
  /** Prefix for `surfaceId` — combined with `requestId` to form e.g. "access-request-abc123". */
  surfaceIdPrefix: string;
  /** Top-level card title shown in the surface header (e.g. "Access Request", "Tool Approval"). */
  cardTitle: string;
  /** Primary line inside the card (typically the requester's display name). */
  requesterName: string;
  /** Secondary line below the requester name (e.g. "Requesting access to the assistant"). */
  subtitle: string;
  /** Markdown body — blockquotes, warnings, links, etc. */
  body: string;
  /** Key-value metadata grid rendered below the body. */
  metadata: Array<{ label: string; value: string }>;
  /** When present, Approve/Reject buttons are wired with `apr:<requestId>:*` action IDs. */
  requestId?: string;
  /** Plain-text content for the fallback `text` block. */
  fallbackText: string;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build a `[ui_surface, text]` block pair for a guardian approval notification.
 *
 * The `ui_surface` block renders as a card with Approve/Reject buttons in
 * clients that support Surface rendering. The `text` block provides a
 * plain-text fallback for older clients, search indexing, and CLI display.
 */
export function buildApprovalCardBlocks(params: ApprovalCardParams): unknown[] {
  const {
    surfaceIdPrefix,
    cardTitle,
    requesterName,
    subtitle,
    body,
    metadata,
    requestId,
    fallbackText,
  } = params;

  const actions = requestId
    ? [
        {
          id: `apr:${requestId}:approve_once`,
          label: "Approve",
          style: "primary",
        },
        {
          id: `apr:${requestId}:reject`,
          label: "Reject",
          style: "destructive",
        },
      ]
    : undefined;

  const surfaceBlock = {
    type: "ui_surface" as const,
    surfaceId: `${surfaceIdPrefix}-${requestId ?? "unknown"}`,
    surfaceType: "card" as const,
    title: cardTitle,
    data: {
      title: requesterName,
      subtitle,
      body,
      metadata,
    },
    ...(actions ? { actions } : {}),
  };

  const textBlock = {
    type: "text" as const,
    text: fallbackText,
  };

  return [surfaceBlock, textBlock];
}
