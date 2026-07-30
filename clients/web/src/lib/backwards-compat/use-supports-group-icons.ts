/**
 * Backwards-compat gate: conversation-group icons.
 *
 * Old behavior (< MIN_VERSION): the daemon's group rows carry no `icon`
 * column and `POST /v1/groups` / `PATCH /v1/groups/:groupId` ignore an
 * `icon` field, so a picked icon would silently fail to persist. The
 * group create/rename dialog hides its icon picker and the client never
 * sends `icon` on group writes.
 *
 * New behavior (≥ MIN_VERSION): groups persist a nullable `icon` name; the
 * dialog shows the picker and group writes include the field.
 *
 * Reading needs no gate: an older daemon simply omits `icon` from
 * `GET /v1/groups` and the sidebar falls back to its default rendering.
 *
 * MIN_VERSION names the next scheduled cut from main. A hotfix release
 * branches from the latest release tag instead, so a hotfix that claims
 * this version number would NOT carry the feature; if that happens,
 * retarget this gate to the next scheduled cut's number.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.1";

/**
 * Returns `true` when the active assistant persists group icons. Subscribes
 * to the identity store so consumers re-render when the assistant version
 * crosses `MIN_VERSION`; conservative `false` while the version is unknown.
 */
export function useSupportsGroupIcons(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
