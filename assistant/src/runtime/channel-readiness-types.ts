// Channel readiness types — reusable primitive for all channels.

import type { ChannelId } from "../channels/types.js";

export type { ChannelId };

/** Setup progress for a channel: not_configured → incomplete → ready. */
export type SetupStatus = "not_configured" | "incomplete" | "ready";

/** Result of a single readiness check (local or remote). */
export interface ReadinessCheckResult {
  name: string;
  /**
   * Whether the check found a fault. This drives the user-facing fault
   * reporting: a check that did not fail must not be shown as broken.
   */
  passed: boolean;
  message: string;
  /**
   * Set when the check could not establish its claim either way, as opposed to
   * establishing that nothing is wrong.
   *
   * `passed` alone cannot express this. A probe that cannot reach a provider,
   * or that lacks the evidence to confirm ownership, has found no fault, so
   * failing it would paint working installs broken over a network blip. But it
   * has also verified nothing, so counting it toward readiness lets a channel
   * report itself live on the strength of a check that never ran. Consumers
   * that report faults read `passed`; consumers that require proof (readiness,
   * and the setup skills that gate their success message on it) additionally
   * require this to be absent or false.
   */
  indeterminate?: boolean;
}

/** Point-in-time snapshot of a channel's readiness state. */
export interface ChannelReadinessSnapshot {
  channel: ChannelId;
  ready: boolean;
  setupStatus: SetupStatus;
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
