/**
 * Shared anchored-guardian resolution.
 *
 * Resolves the guardian identity for an inbound access request using the
 * assistant's vellum principal as the trust anchor: a source-channel guardian
 * is only accepted when its principal matches the anchor, otherwise the vellum
 * anchor identity is used. This blocks stale or cross-assistant contacts from
 * being bound to a request.
 *
 * Resolves from the gateway delivery list, the source of truth for guardian
 * principals.
 */

import type { GuardianDelivery } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { guardianForChannel } from "../contacts/guardian-delivery-reader.js";
import type { GuardianResolutionSource } from "../notifications/signal.js";

/** Resolved guardian identity, anchored on the assistant's vellum principal. */
export interface AnchoredGuardian {
  principalId: string | null;
  address: string;
  displayName: string | null;
  channelType: string;
  source: GuardianResolutionSource;
}

export interface ResolveAnchoredGuardianInput {
  /** Gateway delivery list; `null` when the gateway read failed/was empty. */
  guardians: GuardianDelivery[] | null;
  sourceChannel: ChannelId;
  /**
   * Require a non-null anchor principal for the vellum-anchor arm. When the
   * vellum guardian has no principal, return `null` instead of a vellum-anchor
   * record. Matches the cosmetic label path, which degrades to the default
   * reference when the anchor principal is absent.
   */
  requireAnchorPrincipal?: boolean;
}

/**
 * Resolve the anchored guardian for `sourceChannel`, or `null` when none can be
 * resolved. Gateway source-channel match → that record; gateway anchor-only →
 * vellum-anchor.
 */
export function resolveAnchoredGuardian(
  input: ResolveAnchoredGuardianInput,
): AnchoredGuardian | null {
  const { sourceChannel, requireAnchorPrincipal } = input;
  const guardians = input.guardians ?? [];

  const vellumGuardian = guardianForChannel(guardians, "vellum");
  const anchorPrincipalId = vellumGuardian?.principalId;

  let resolved: AnchoredGuardian | null = null;

  // Source-channel guardian, but only when it maps to the assistant's anchored
  // principal. This blocks cross-assistant/stale binding selection.
  const sourceGuardian = guardianForChannel(guardians, sourceChannel);
  if (
    anchorPrincipalId &&
    sourceGuardian &&
    sourceGuardian.principalId === anchorPrincipalId
  ) {
    resolved = {
      principalId: sourceGuardian.principalId,
      address: sourceGuardian.address,
      displayName: sourceGuardian.displayName ?? null,
      channelType: sourceGuardian.channelType,
      source: "source-channel-contact",
    };
  } else if (vellumGuardian && !(requireAnchorPrincipal && !anchorPrincipalId)) {
    // Source-channel resolution did not match the anchor → use the anchored
    // vellum identity.
    resolved = {
      principalId: anchorPrincipalId ?? null,
      address: vellumGuardian.address,
      displayName: vellumGuardian.displayName ?? null,
      channelType: "vellum",
      source: "vellum-anchor",
    };
  }

  return resolved;
}
