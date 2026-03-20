/** Broadcast to connected clients when a service group update is about to begin. */
export interface ServiceGroupUpdateStarting {
  type: "service_group_update_starting";
  /** The version being upgraded to. */
  targetVersion: string;
  /** Estimated seconds of downtime. */
  expectedDowntimeSeconds: number;
}

/** Broadcast to connected clients when a service group update has completed. */
export interface ServiceGroupUpdateComplete {
  type: "service_group_update_complete";
  /** The version that was installed (may differ from target if rolled back). */
  installedVersion: string;
  /** Whether the update succeeded or rolled back. */
  success: boolean;
  /** If rolled back, the version reverted to. */
  rolledBackToVersion?: string;
}

export type _UpgradesServerMessages =
  | ServiceGroupUpdateStarting
  | ServiceGroupUpdateComplete;
