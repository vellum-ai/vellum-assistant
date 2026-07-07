/**
 * One-line identity provenance for the contact detail header, derived from
 * the existing `verifiedVia`/`verifiedAt` audit fields on the contact's
 * linkable channels — e.g. "Linked to @handle via workspace roster · Jul 7"
 * (guardian_linked) or "Verified via intro card · Jul 7" (handshake).
 */
import {
  channelLinkProvenance,
  LINKABLE_CHANNEL_IDS,
  type RosterAccount,
} from "@/domains/contacts/channel-linking";
import type {
  ContactChannelPayload,
  ContactPayload,
} from "@/domains/contacts/types";

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function withDate(line: string, verifiedAt: number | null | undefined): string {
  return verifiedAt != null ? `${line} · ${formatShortDate(verifiedAt)}` : line;
}

/** The contact's most recently verified linkable channel, if any. */
function verifiedLinkableChannel(
  contact: Pick<ContactPayload, "channels">,
): ContactChannelPayload | null {
  let best: ContactChannelPayload | null = null;
  for (const channel of contact.channels) {
    if (
      !LINKABLE_CHANNEL_IDS.has(channel.type) ||
      !channelLinkProvenance(channel)
    ) {
      continue;
    }
    if (!best || (channel.verifiedAt ?? 0) > (best.verifiedAt ?? 0)) {
      best = channel;
    }
  }
  return best;
}

export function contactProvenanceLine(
  contact: Pick<ContactPayload, "channels">,
  rosterByChannel?: Partial<Record<string, RosterAccount[]>>,
): string | null {
  const channel = verifiedLinkableChannel(contact);
  if (!channel) {
    return null;
  }
  if (channelLinkProvenance(channel) === "guardian_linked") {
    // The roster is the only handle source (channels store the provider
    // account ID); fall back to the raw ID when no roster is cached.
    const account = rosterByChannel?.[channel.type]?.find(
      (candidate) => candidate.id === channel.address,
    );
    return withDate(
      `Linked to ${account ? `@${account.username}` : channel.address} via workspace roster`,
      channel.verifiedAt,
    );
  }
  return withDate("Verified via intro card", channel.verifiedAt);
}
