/**
 * Host UI-snapshot proxy SSE events (`host_ui_snapshot_request` /
 * `host_ui_snapshot_cancel`).
 *
 * Server → client instruction asking the desktop client to render a
 * staged view of the app's own UI with the current workspace-theme
 * tokens applied, capture it, and POST the PNG back to
 * `/v1/host-ui-snapshot-result`. `host_ui_snapshot_cancel` withdraws an
 * in-flight request. The stage contains only fixed generic content —
 * never user data.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/** Staged compositions the web client can render for capture. */
export const HostUiSnapshotViewSchema = z.enum(["sampler", "chat"]);

export type HostUiSnapshotView = z.infer<typeof HostUiSnapshotViewSchema>;

export const HostUiSnapshotRequestEventSchema = z.object({
  type: z.literal("host_ui_snapshot_request"),
  requestId: z.string(),
  view: HostUiSnapshotViewSchema,
  /**
   * Validated workspace-theme tokens to apply on the stage. Absent when no
   * valid theme exists — the stage renders the built-in base theme.
   */
  tokens: z.record(z.string(), z.string()).optional(),
});

export type HostUiSnapshotRequestEvent = z.infer<
  typeof HostUiSnapshotRequestEventSchema
>;

export const HostUiSnapshotCancelEventSchema = z.object({
  type: z.literal("host_ui_snapshot_cancel"),
  requestId: z.string(),
});

export type HostUiSnapshotCancelEvent = z.infer<
  typeof HostUiSnapshotCancelEventSchema
>;
