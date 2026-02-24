// Channel readiness types — reusable primitive for all channels.

/** Logical channel identifier. Well-known channels have literal types; custom channels use string. */
export type ChannelId = 'sms' | 'telegram' | string;

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

/** Probe interface that channels implement to provide readiness checks. */
export interface ChannelProbe {
  channel: ChannelId;
  runLocalChecks(): ReadinessCheckResult[];
  runRemoteChecks?(): Promise<ReadinessCheckResult[]>;
}
