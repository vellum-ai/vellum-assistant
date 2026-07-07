/**
 * Adapter seam for the contact "Link account" flow.
 *
 * Linking an existing channel account to a contact is channel-agnostic on
 * the gateway side (contact-channel upsert + manual verify — the gateway DB
 * is the ACL source of truth). What is per-adapter is the roster source: a
 * daemon route enumerating the accounts the assistant can see on that
 * channel (`GET /v1/slack/users` today), normalized to {@link RosterAccount}.
 *
 * To make another adapter linkable (e.g. Discord):
 *  1. add its roster route daemon-side, returning the RosterAccount shape;
 *  2. add a roster query-options module beside `slack-users-query.ts`;
 *  3. register the channel id in {@link LINKABLE_CHANNEL_IDS} and give the
 *     contacts page an `useAccountLink` controller for it.
 */
import type { ContactChannelPayload } from "@/domains/contacts/types";

/**
 * Channel ids whose contact rows get the dual Link account + Invite
 * treatment. Slack-only for v1 (LUM-2701); other adapters need more
 * investigation before getting it.
 */
export const LINKABLE_CHANNEL_IDS: ReadonlySet<string> = new Set(["slack"]);

/**
 * Normalized account row every per-adapter roster endpoint returns.
 * `GET /v1/slack/users` is the first implementation of this contract.
 */
export interface RosterAccount {
  id: string;
  username: string;
  displayName: string;
  imageUrl: string | null;
}

/**
 * A contact channel counts as verified when explicitly marked so, or when
 * active with a recorded verification timestamp.
 */
export function isVerifiedContactChannel(
  channel: Pick<ContactChannelPayload, "status" | "verifiedAt">,
): boolean {
  return (
    channel.status === "verified" ||
    (channel.status === "active" && channel.verifiedAt != null)
  );
}

/**
 * How a verified channel binding came to be, from the channel's existing
 * `verifiedVia` audit field:
 *
 *  - `guardian_linked` — the guardian manually attached the account
 *    (`verifiedVia: "manual"`, e.g. via the workspace roster picker).
 *  - `handshake` — the contact verified themselves (code challenge or
 *    invite redemption).
 *
 * Downstream ACL treats both as verified; the split is display-only audit
 * provenance. Returns null for unverified channels.
 */
export type ChannelLinkProvenance = "guardian_linked" | "handshake";

export function channelLinkProvenance(
  channel: Pick<ContactChannelPayload, "status" | "verifiedAt" | "verifiedVia">,
): ChannelLinkProvenance | null {
  if (!isVerifiedContactChannel(channel)) {
    return null;
  }
  return channel.verifiedVia === "manual" ? "guardian_linked" : "handshake";
}
