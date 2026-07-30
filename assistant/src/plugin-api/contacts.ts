/**
 * Plugin-facing contact lookup.
 *
 * A plugin that owns an inbound channel needs to answer one question before it
 * lets a message reach the agent loop: **is this sender someone the user
 * knows?** {@link findContactByChannelAddress} answers exactly that and nothing
 * more. It is deliberately read-only — plugins do not create, modify, or delete
 * contacts, because a channel that could mint its own contacts could admit its
 * own senders.
 *
 * ## This is a lookup, not an admission decision
 *
 * The canonical admission path is the gateway's: trust classification against
 * `actorExternalId`, then the per-channel admission floor. A plugin that
 * forwards inbound through the host's channel pipeline gets that for free and
 * should not re-derive it here.
 *
 * This exists for the narrower case of a plugin that must gate a sender itself.
 * Two things follow, and getting either wrong turns the gate into a hole:
 *
 * - **A `null` result means "not a known contact", not "unknown, allow".**
 * - **An absent `status` means the gateway could not be reached.** The ACL is
 *   gateway-owned, so an unreachable read is unknown standing, not good
 *   standing. A gate must treat `undefined` the same as `blocked`. The
 *   host-internal reader this wraps fails *open* for its own callers, which are
 *   display paths where a missing badge is better than an error; a gate has the
 *   opposite requirement, and the difference is why the field is optional here
 *   rather than defaulted.
 */

import { findContactChannel } from "../contacts/contact-store.js";
import { gatewayContactChannelState } from "../contacts/gateway-channel-read.js";

/** A contact channel matching an inbound address. */
export interface PluginContactMatch {
  contactId: string;
  displayName: string;
  /** Channel type the match was found under. */
  channelType: string;
  /** Address as stored, which may be canonicalized from the query. */
  address: string;
  /**
   * Gateway-owned channel status — `active`, `pending`, `unverified`,
   * `revoked`, or `blocked`.
   *
   * `undefined` when the gateway could not be reached or holds no row for this
   * channel. Callers gating admission must treat that as untrusted; see the
   * module docs.
   */
  status: string | undefined;
  /** Epoch ms the channel was verified, when the gateway reports one. */
  verifiedAt: number | null | undefined;
}

/**
 * Find the contact reachable at `address` on `channelType`.
 *
 * `channelType` is the contact-channel vocabulary (`phone`, `email`, `slack`,
 * …), which is not the same set as the gateway's `ChannelId`. A channel whose
 * identity is a phone number can look up under `phone` and match a contact the
 * user already has, without minting a channel type of its own.
 *
 * Returns `null` when no contact holds that address.
 */
export async function findContactByChannelAddress(
  channelType: string,
  address: string,
): Promise<PluginContactMatch | null> {
  const match = findContactChannel({ channelType, address });
  if (!match) return null;

  const state = await gatewayContactChannelState({
    contactId: match.channel.contactId,
    type: match.channel.type,
    address: match.channel.address,
  });

  return {
    contactId: match.contact.id,
    displayName: match.contact.displayName,
    channelType: match.channel.type,
    address: match.channel.address,
    status: state?.status,
    verifiedAt: state?.verifiedAt,
  };
}
