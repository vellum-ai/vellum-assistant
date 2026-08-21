import { isCharacterTraits } from "@/types/avatar";
import type { AvatarState } from "@/types/avatar";

/**
 * Maps an assistant avatar onto the name of a bundled iOS alternate app icon.
 *
 * The iOS shell ships one alternate icon per character combination, named
 * `avatar-<bodyShape>-<eyeStyle>-<color>` by the icon bundle generator. That
 * name is the wire contract between the generated bundles and the runtime, so
 * it is produced in exactly one place: `appIconNameForAvatar`.
 */

/**
 * The installed shell's alternate-icon capability, typed structurally so this
 * module does not depend on the native plugin wrapper that reports it.
 */
export interface AppIconAvailability {
  /** False on web, Android, and iOS builds without alternate-icon support. */
  supported: boolean;
  /** The alternate icon currently applied, or null for the default icon. */
  current: string | null;
  /** Alternate icon names the installed binary actually bundles. */
  available: string[];
}

/** A resolved icon target plus whether the installed shell can apply it. */
export interface AppIconTarget {
  /** The icon name this avatar maps to, or null when it maps to none. */
  target: string | null;
  /** True only when `target` is an icon the installed shell bundles. */
  availableMatch: boolean;
}

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
  return `avatar-${traits.bodyShape}-${traits.eyeStyle}-${traits.color}`;
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
  iconState: AppIconAvailability,
): AppIconTarget {
  const target = appIconNameForAvatar(state);
  const availableMatch =
    iconState.supported &&
    target !== null &&
    iconState.available.includes(target);
  return { target, availableMatch };
}
