/**
 * What the companion's popover shows: the approvals the turn is blocked on,
 * the credential it asked for, or the surface the assistant last put up in
 * this conversation.
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
  COMPANION_POPOVER_APPROVALS_MAX,
  COMPANION_POPOVER_BODY_MAX,
  type CompanionApproval,
  type CompanionPopover,
  type CompanionPopoverAction,
  type CompanionPopoverPermission,
} from "@vellumai/ipc-contract";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { PendingConfirmationState } from "@/domains/chat/types";
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

/** A pending approval, and the tool call it is attached to when it has one. */
export interface PendingApproval {
  confirmation: PendingConfirmationState;
  toolCall?: ChatMessageToolCall;
}

/**
 * Every approval the turn is waiting on, oldest first.
 *
 * Tools run in parallel, so several can be pending at once. Each rides its
 * own tool call in the transcript; the interaction store holds only the latest
 * one, and is read as well for a request no tool call carries.
 */
export function pendingApprovals(): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  const seen = new Set<string>();
  for (const message of useChatSessionStore.getState().snapshot?.messages ??
    []) {
    for (const toolCall of message.toolCalls ?? []) {
      const pending = toolCall.pendingConfirmation;
      if (
        pending === undefined ||
        pending === null ||
        seen.has(pending.requestId)
      ) {
        continue;
      }
      seen.add(pending.requestId);
      approvals.push({
        confirmation: {
          ...pending,
          toolName: pending.toolName ?? toolCall.name,
          input: pending.input ?? toolCall.input,
        },
        toolCall,
      });
    }
  }
  const latest = useInteractionStore.getState().pendingConfirmation;
  if (latest !== null && !seen.has(latest.requestId)) {
    approvals.push({ confirmation: latest });
  }
  return approvals;
}

function popoverApproval({ confirmation }: PendingApproval): CompanionApproval {
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
    id: confirmation.requestId,
    title: bounded(context, 300),
    detail: bounded(ask ?? "", 1000),
    ...(permission !== undefined ? { permission } : {}),
  };
}

/**
 * The integration a credential's service names, for its logo: the service
 * lowercased with anything but letters and digits made an underscore, which
 * is the shape provider keys take. An unknown key draws the service's
 * initials.
 */
const providerKeyFor = (service: string): string =>
  service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * What the popover should show right now, or nothing.
 *
 * Approvals first: the turn is stopped until they are answered, and the rest
 * will still be there after. Then a credential, which stops the turn the same
 * way. Then the offered surface.
 */
export function currentCompanionPopover(): CompanionPopover | undefined {
  const approvals = pendingApprovals().slice(
    0,
    COMPANION_POPOVER_APPROVALS_MAX,
  );
  if (approvals.length > 0) {
    const items = approvals.map(popoverApproval);
    return {
      kind: "approvals",
      id: items.map((item) => item.id).join(","),
      items,
    };
  }
  const secret = useInteractionStore.getState().pendingSecret;
  if (secret !== null) {
    const service = bounded(secret.service ?? "", 120);
    const providerKey = providerKeyFor(service);
    return {
      kind: "secret",
      id: secret.requestId,
      service,
      ...(providerKey !== "" ? { providerKey: bounded(providerKey, 80) } : {}),
      detail: bounded(secret.purpose ?? secret.description ?? "", 1000),
      label: bounded(secret.label ?? secret.field ?? "", 120),
      placeholder: bounded(secret.placeholder ?? "", 200),
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
