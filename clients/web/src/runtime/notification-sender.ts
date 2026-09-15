import {
  NOTIFICATION_SENDER_NAME_MAX_CHARS,
  type NotificationIdentity,
  type NotificationNameProvenance,
  type NotificationPresentation,
  type NotificationSender,
} from "@vellumai/ipc-contract";

import {
  sameNotificationIdentity,
  type NotificationIdentitySnapshot,
} from "@/runtime/notification-avatar";

export interface OwnedNotificationName {
  identity: NotificationIdentity;
  name: string | null | undefined;
}

export interface ResolveNotificationSenderInput {
  /** A caller-owned flag decision. The resolver does not read surface flags. */
  presentation: NotificationPresentation;
  identity: NotificationIdentity;
  /** Verified name carried by this notification event. */
  assistantName?: string | null;
  /** Current identity-store value, stamped with the identity it belongs to. */
  identityStoreName?: OwnedNotificationName | null;
  /** Process-local verified snapshot for the target identity. */
  verifiedSnapshot?: NotificationIdentitySnapshot | null;
  title: string;
}

export type NotificationSenderResolution =
  | {
      presentation: "app";
      identity: NotificationIdentity;
    }
  | {
      presentation: "assistant";
      identity: NotificationIdentity;
      name: string;
      nameProvenance: NotificationNameProvenance;
      sender?: NotificationSender;
      suppressGroupTitle?: true;
    };

function boundedName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, NOTIFICATION_SENDER_NAME_MAX_CHARS).trimEnd();
}

function exactOwnedName(
  candidate: OwnedNotificationName | null | undefined,
  identity: NotificationIdentity,
): string | null {
  return candidate && sameNotificationIdentity(candidate.identity, identity)
    ? boundedName(candidate.name)
    : null;
}

/**
 * Resolve notification presentation and optional inline sender decoration.
 * The event name, exact identity store, verified memory, and title are the
 * only name rungs, in that order.
 */
export function resolveNotificationSender(
  input: ResolveNotificationSenderInput,
): NotificationSenderResolution {
  if (input.presentation === "app") {
    return { presentation: "app", identity: input.identity };
  }

  const snapshotMatches =
    input.verifiedSnapshot &&
    sameNotificationIdentity(input.verifiedSnapshot.identity, input.identity)
      ? input.verifiedSnapshot
      : null;
  const candidates: Array<{
    name: string | null;
    provenance: NotificationNameProvenance;
  }> = [
    { name: boundedName(input.assistantName), provenance: "event" },
    {
      name: exactOwnedName(input.identityStoreName, input.identity),
      provenance: "identity-store",
    },
    {
      name: snapshotMatches?.nameProvenance
        ? boundedName(snapshotMatches.name)
        : null,
      provenance: "verified-memory",
    },
    { name: boundedName(input.title), provenance: "title" },
  ];
  const selected = candidates.find((candidate) => candidate.name !== null);
  if (!selected?.name) {
    return { presentation: "app", identity: input.identity };
  }

  const sender = snapshotMatches?.avatar
    ? {
        id: input.identity.nativeSenderId,
        name: selected.name,
        ...snapshotMatches.avatar,
      }
    : undefined;
  return {
    presentation: "assistant",
    identity: input.identity,
    name: selected.name,
    nameProvenance: selected.provenance,
    ...(sender ? { sender } : {}),
    ...(selected.provenance === "title" ? { suppressGroupTitle: true } : {}),
  };
}
