import { isCharacterTraits } from "@/types/avatar";
import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

/**
 * Maps an assistant avatar onto the name of a bundled iOS alternate app icon.
 *
 * The iOS shell ships one alternate icon per character combination, named
 * `avatar-<bodyShape>-<eyeStyle>-<color>` by the icon bundle generator. That
 * name is the wire contract between the generated bundles and the runtime, so
 * it is produced in exactly one place: `appIconNameForAvatar`.
 */

/** A resolved icon target plus whether the installed shell can apply it. */
export interface AppIconTarget {
  /** The icon name this avatar maps to, or null when it maps to none. */
  target: string | null;
  /** True only when `target` is an icon the installed shell bundles. */
  availableMatch: boolean;
}

/** The namespace every icon this feature applies is emitted under. */
const AVATAR_ICON_PREFIX = "avatar-";

/**
 * The single chokepoint for the invariant that only character avatars have an
 * app icon. Uploaded images, AI-generated avatars, and "no avatar" all return
 * null here, so nothing downstream can offer or apply an icon for them, and a
 * character state with malformed traits returns null rather than a name built
 * from `undefined`.
 */
export function appIconNameForAvatar(state: AvatarState | null): string | null {
  if (state === null || state.kind !== "character") {
    return null;
  }
  const traits = state.traits;
  if (!isCharacterTraits(traits)) {
    return null;
  }
  return `${AVATAR_ICON_PREFIX}${traits.bodyShape}-${traits.eyeStyle}-${traits.color}`;
}

/**
 * True when the applied icon is one this feature put there, whatever the
 * avatar says today. Settings needs this to keep offering Reset after a
 * successful match, and after an avatar changes to one with no icon of its
 * own: the applied name is the only record that we ever swapped, since nothing
 * here resets an icon on its own.
 */
export function isAvatarAppIcon(name: string | null): boolean {
  return name !== null && name.startsWith(AVATAR_ICON_PREFIX);
}

/**
 * Resolve the icon an avatar wants and whether the installed shell can apply
 * it. This is where version skew becomes a no-op: a web build that knows a
 * trait combination the installed binary has no bundle for, or an older shell
 * with no alternate-icon support at all, reports `availableMatch: false` and
 * callers leave the icon alone.
 */
export function resolveAppIconTarget(
  state: AvatarState | null,
  iconState: AppIconState,
): AppIconTarget {
  const target = appIconNameForAvatar(state);
  const availableMatch =
    iconState.supported &&
    target !== null &&
    iconState.available.includes(target);
  return { target, availableMatch };
}
