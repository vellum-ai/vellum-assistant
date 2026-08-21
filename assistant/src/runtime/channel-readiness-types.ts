// Channel readiness types — reusable primitive for all channels.

import type { ChannelId } from "../channels/types.js";

export type { ChannelId };

/**
 * Setup progress for a channel: not_configured → incomplete → ready.
 *
 * Progress only. A channel that is fully configured is `ready` here even when
 * it is not currently working, because "have I finished setting this up" and
 * "is it working right now" are different questions with different answers and
 * different remedies. Operational state is {@link ChannelHealth}.
 */
export const SETUP_STATUSES = [
  "not_configured",
  "incomplete",
  "ready",
] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

/** What a check establishes. */
export const CHECK_KINDS = [
  /** Whether the channel is configured: credentials, ingress, policy. */
  "configuration",
  /** Whether the channel is currently working: is anything arriving. */
  "operational",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * Whether a configured channel is currently working.
 *
 * Absent when a channel measures no operational checks at all, which is not
 * the same as failing to establish them: nothing was asked, so nothing is
 * claimed either way, and readiness is decided on configuration alone.
 */
export const CHANNEL_HEALTHS = [
  /** Every operational check confirmed the channel is working. */
  "ok",
  /** An operational check found a fault. */
  "failing",
  /** Operational checks ran but established nothing either way. */
  "unknown",
] as const;
export type ChannelHealth = (typeof CHANNEL_HEALTHS)[number];

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
  /**
   * Which question this check answers. Defaults to `configuration`, so a
   * check that does not say is treated as setup evidence rather than as a
   * claim about whether the channel is working.
   */
  kind?: CheckKind;
}

/** Point-in-time snapshot of a channel's readiness state. */
export interface ChannelReadinessSnapshot {
  channel: ChannelId;
  /** Configured and confirmed working: `setupStatus === "ready"` and health is not in doubt. */
  ready: boolean;
  setupStatus: SetupStatus;
  /** Absent when the channel measures no operational checks. */
  health?: ChannelHealth;
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
