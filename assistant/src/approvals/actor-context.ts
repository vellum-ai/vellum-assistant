/**
 * Canonical actor context used by guardian decision flows.
 *
 * Keeps identity normalization and trusted/untrusted construction consistent
 * across HTTP, IPC, and channel reply routing paths.
 */

export interface ActorContext {
  /** External user ID of the deciding actor (undefined for desktop/trusted). */
  externalUserId: string | undefined;
  /** Channel the decision arrived on. */
  channel: string;
  /** Whether the actor is a trusted/desktop context. */
  isTrusted: boolean;
}

export function buildActorContext(params: {
  channel: string;
  externalUserId?: string | null;
  isTrusted: boolean;
}): ActorContext {
  const externalUserId = typeof params.externalUserId === 'string' && params.externalUserId.trim().length > 0
    ? params.externalUserId.trim()
    : undefined;
  return {
    externalUserId,
    channel: params.channel,
    isTrusted: params.isTrusted,
  };
}

export function buildTrustedActorContext(channel: string): ActorContext {
  return {
    externalUserId: undefined,
    channel,
    isTrusted: true,
  };
}
