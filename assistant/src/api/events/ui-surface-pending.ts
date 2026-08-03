/**
 * `ui_surface_pending` SSE event.
 *
 * Server → client notice that a `ui_show` call whose input is still streaming
 * will produce a surface of `surfaceType`, so the client can hold a
 * placeholder for it. Authoring a `visual` fragment is the longest input
 * stream the model produces, and until the call closes there is nothing on
 * screen at all: the `ui_show` chip is suppressed (the surface renders in its
 * place) and the surface itself does not exist yet.
 *
 * The daemon emits this at most once per tool call, as soon as the
 * accumulated tool input names a surface type worth a placeholder. It carries
 * no input: the fragment is large and the client only needs to know that one
 * is coming.
 *
 * `toolUseId` is the id of the producing `ui_show` call, the correlation key
 * the client uses to retire the placeholder when the call resolves.
 * `messageId` is the assistant row the call belongs to when the daemon has
 * already opened one.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UISurfacePendingEventSchema = z.object({
  type: z.literal("ui_surface_pending"),
  conversationId: z.string(),
  surfaceType: z.literal("visual"),
  toolUseId: z.string(),
  messageId: z.string().optional(),
});

export type UISurfacePendingEvent = z.infer<typeof UISurfacePendingEventSchema>;
