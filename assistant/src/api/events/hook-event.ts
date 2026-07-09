/**
 * `hook_event` SSE event.
 *
 * A best-effort, transient signal a lifecycle hook emits to any UI watching
 * the conversation — e.g. a `user-prompt-submit` hook reporting progress
 * while it does work the user can feel (memory selection).
 *
 * The daemon stamps the `hookName` the emit came from and the `owner` — a
 * `{ kind, id }` descriptor mirroring the tool/skill registry's `OwnerInfo`,
 * so clients can tell a plugin hook (`{ kind: "plugin", id: <plugin name> }`)
 * from a standalone workspace hook (`{ kind: "workspace", id }`). The hook
 * supplies only `detail`, an arbitrary JSON-serializable record whose shape
 * the emitting hook and its client renderer agree on out of band — this event
 * carries no schema for it. A hook cannot emit any other event type: the emit
 * surface is bound to the turn.
 *
 * `conversationId` is optional: most hooks fire inside a conversation and the
 * event is scoped to it, but hooks that run outside one (future non-turn
 * lifecycle events) may emit without it.
 *
 * Delivered and replayed through the standard SSE stream like every other
 * event; "transient" is a rendering contract — clients show it as ephemeral
 * progress and drop it when the turn moves on, not a persistence guarantee.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

/**
 * Owner of an emitting hook. Mirrors the tool/skill registry's `OwnerInfo`
 * (`{ kind, id }`), narrowed to the two kinds a hook owner can be: a plugin
 * (default or user) or the standalone-workspace-hooks owner.
 */
export const HookEventOwnerSchema = z.object({
  kind: z.enum(["plugin", "workspace"]),
  id: z.string(),
});

export type HookEventOwner = z.infer<typeof HookEventOwnerSchema>;

export const HookEventSchema = z.object({
  type: z.literal("hook_event"),
  conversationId: z.string().optional(),
  /** The lifecycle hook the emit originated from (e.g. `user-prompt-submit`). */
  hookName: z.string(),
  owner: HookEventOwnerSchema,
  /** Hook-supplied payload; opaque to the transport. */
  detail: z.record(z.string(), z.unknown()),
});

export type HookEvent = z.infer<typeof HookEventSchema>;
