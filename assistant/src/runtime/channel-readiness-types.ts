// Channel readiness types — reusable primitive for all channels.

import type { ChannelId } from "../channels/types.js";

export type { ChannelId };

/** Result of a single readiness check (local or remote). */
export interface ReadinessCheckResult {
  name: string;
  passed: boolean;
  message: string;
}

/** Point-in-time snapshot of a channel's readiness state. */
export interface ChannelReadinessSnapshot {
  channel: ChannelId;
  ready: boolean;
  checkedAt: number;
  stale: boolean;
  reasons: Array<{ code: string; text: string }>;
  localChecks: ReadinessCheckResult[];
  remoteChecks?: ReadinessCheckResult[];
}

/** Optional probe context for readiness checks. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ChannelProbeContext {}

export type Awaitable<T> = T | Promise<T>;

/** Probe interface that channels implement to provide readiness checks. */
export interface ChannelProbe {
  channel: ChannelId;
  runLocalChecks(
    context?: ChannelProbeContext,
  ): Awaitable<ReadinessCheckResult[]>;
  runRemoteChecks?(
    context?: ChannelProbeContext,
  ): Promise<ReadinessCheckResult[]>;
}
