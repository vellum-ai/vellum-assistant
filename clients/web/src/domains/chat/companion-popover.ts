/**
 * What the companion's popover shows: the approval the turn is blocked on, or
 * the surface the assistant last put up in this conversation.
 *
 * The companion is its own renderer with no conversation in it, so this window
 * works out what is worth showing, words it, and publishes it through the
 * companion mirror. Main decides whether the popover is on screen, which is
 * whenever the companion is (see `companion-popover-window.ts`), so nothing
 * here asks where the user is looking.
 */

import { create } from "zustand";

import {
  COMPANION_POPOVER_ACTIONS_MAX,
  COMPANION_POPOVER_BODY_MAX,
  type CompanionPopover,
  type CompanionPopoverAction,
  type CompanionPopoverPermission,
} from "@vellumai/ipc-contract";
import { CardSurfaceDataSchema } from "@vellumai/assistant-api";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { Surface } from "@/domains/chat/types/types";
import { confirmationAsk } from "@/domains/chat/utils/confirmation-ask";

interface CompanionPopoverState {
  /**
   * The surface the assistant last showed while this window was listening,
   * until the user dismisses it from the popover.
   *
   * Recorded on the live `ui_surface_show` rather than read off the
   * transcript, so a conversation opened from history does not put its old
   * surfaces in front of the user.
   */
  offeredSurfaceId: string | null;
}

export const useCompanionPopoverStore = create<CompanionPopoverState>()(() => ({
  offeredSurfaceId: null,
}));

export function offerSurfaceToCompanion(surfaceId: string): void {
  useCompanionPopoverStore.setState({ offeredSurfaceId: surfaceId });
}

/** Stop offering a surface, if it is still the one offered. */
export function withdrawSurfaceFromCompanion(surfaceId: string): void {
  if (useCompanionPopoverStore.getState().offeredSurfaceId !== surfaceId) {
    return;
  }
  useCompanionPopoverStore.setState({ offeredSurfaceId: null });
}

/**
 * The privacy panes `request_system_permission` can ask for that the app can
 * open, keyed by the tool's own names.
 */
const PERMISSION_FOR_TOOL: Readonly<
  Record<string, CompanionPopoverPermission>
> = {
  accessibility: "accessibility",
  screen_recording: "screen",
  microphone: "microphone",
};

/** The offered surface, when it is still in this conversation and open. */
export function offeredSurface(): Surface | null {
  const { offeredSurfaceId } = useCompanionPopoverStore.getState();
  if (offeredSurfaceId === null) {
    return null;
  }
  const session = useChatSessionStore.getState();
  if (session.dismissedSurfaceIds.has(offeredSurfaceId)) {
    return null;
  }
  const messages = session.snapshot?.messages ?? [];
  // From the end, since the offered surface is the latest one shown.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const surface = messages[i].surfaces?.find(
      (candidate) => candidate.surfaceId === offeredSurfaceId,
    );
    if (surface !== undefined) {
      return surface.completed === true ? null : surface;
    }
  }
  return null;
}

const bounded = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const actionStyle = (
  style: string | undefined,
): CompanionPopoverAction["style"] =>
  style === "primary" || style === "destructive" ? style : "secondary";

/**
 * A surface as the popover draws it: a plain card in full, anything else
 * named with a way into the app.
 *
 * A card with a template is drawn by a renderer of its own in the app, so it
 * is not flattened to its text here.
 */
function popoverForSurface(surface: Surface): CompanionPopover {
  const card =
    surface.surfaceType === "card"
      ? CardSurfaceDataSchema.safeParse(surface.data)
      : null;
  if (card?.success !== true || card.data.template !== undefined) {
    return {
      kind: "surface",
      id: surface.surfaceId,
      title: bounded(surface.title ?? "", 300),
    };
  }
  const metadata = (card.data.metadata ?? [])
    .map(({ label, value }) => `- **${label}:** ${value}`)
    .join("\n");
  const body = [card.data.body ?? "", metadata]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    kind: "card",
    id: surface.surfaceId,
    title: bounded(card.data.title ?? surface.title ?? "", 300),
    subtitle: bounded(card.data.subtitle ?? "", 300),
    body: bounded(body, COMPANION_POPOVER_BODY_MAX),
    actions: (surface.actions ?? [])
      .slice(0, COMPANION_POPOVER_ACTIONS_MAX)
      .map((action) => ({
        id: action.id,
        label: bounded(action.label, 80),
        style: actionStyle(action.style),
      })),
  };
}

/**
 * What the popover should show right now, or nothing.
 *
 * The approval outranks a surface: the turn is stopped until it is answered,
 * and the surface will still be there after.
 */
export function currentCompanionPopover(): CompanionPopover | undefined {
  const confirmation = useInteractionStore.getState().pendingConfirmation;
  if (confirmation !== null) {
    const toolName = confirmation.toolName ?? "";
    const { context, ask } = confirmationAsk(
      toolName,
      confirmation.input,
      confirmation,
    );
    const requested = confirmation.input?.permission_type;
    const permission =
      toolName === "request_system_permission" &&
      typeof requested === "string" &&
      Object.hasOwn(PERMISSION_FOR_TOOL, requested)
        ? PERMISSION_FOR_TOOL[requested]
        : undefined;
    return {
      kind: "approval",
      id: confirmation.requestId,
      title: bounded(context, 300),
      detail: bounded(ask ?? "", 1000),
      ...(permission !== undefined ? { permission } : {}),
    };
  }
  const surface = offeredSurface();
  return surface === null ? undefined : popoverForSurface(surface);
}

/** Whether two popovers would draw the same thing, absence included. */
export function samePopover(
  a: CompanionPopover | undefined,
  b: CompanionPopover | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
