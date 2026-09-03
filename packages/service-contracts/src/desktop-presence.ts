/**
 * The presence states a desktop client may report. Single runtime source for
 * the daemon's stored type, the client route's wire enum, and the Electron
 * presence monitor.
 *
 * Member order is load-bearing: the route feeds this tuple to `z.enum`, so
 * reordering rewrites the generated `assistant/openapi.yaml`.
 */
export const DESKTOP_PRESENCE_STATES = ["active", "idle", "away"] as const;

export type DesktopPresenceState = (typeof DESKTOP_PRESENCE_STATES)[number];
