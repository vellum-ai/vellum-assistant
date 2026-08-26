import { isCharacterTraits } from "@/types/avatar";
import type { AppIconState } from "@/runtime/app-icon";
import type { AvatarState } from "@/types/avatar";

/**
 * Maps an assistant avatar onto the name of a bundled iOS alternate app icon.
 *
 * The iOS shell ships one alternate icon per eyes-on-color combination, named
 * `avatar-eyes-<eyeStyle>-<color>` by the icon bundle generator. Body shape is
 * not part of an icon, so it is not part of the name, and every avatar that
 * shares an eye style and a color maps to the same icon. That name is the wire
 * contract between the generated bundles and the runtime, so it is composed in
 * exactly one place: `appIconNameForTraits`.
 */

/** A resolved icon target plus whether the installed shell can apply it. */
export interface AppIconTarget {
  /** The icon name this avatar maps to, or null when it maps to none. */
  target: string | null;
  /** True only when `target` is an icon the installed shell bundles. */
  availableMatch: boolean;
}

/** An eyes-on-color pair, the whole of what an icon name carries. */
export interface AppIconTraits {
  eyeStyle: string;
  color: string;
}

/** The namespace every icon this feature applies is emitted under. */
const AVATAR_ICON_PREFIX = "avatar-eyes-";

/**
 * The pair the icon shipped as the app's default is drawn from
 * (`clients/ios/App/App/AppIcon.icon`): quirky eyes on the green field. It
 * carries no alternate-icon name of its own, so a surface previewing "no
 * alternate applied" draws this instead.
 */
export const DEFAULT_APP_ICON_TRAITS: AppIconTraits = {
  eyeStyle: "quirky",
  color: "green",
};

/**
 * Composes the bundled icon name for an eyes-on-color pair. The picker builds
 * names from traits the user cycled through rather than from an avatar, so this
 * is the one place the wire contract is spelled out and every other producer
 * goes through it.
 */
export function appIconNameForTraits(eyeStyle: string, color: string): string {
  return `${AVATAR_ICON_PREFIX}${eyeStyle}-${color}`;
}

/**
 * The single chokepoint for the invariant that only character avatars have an
 * icon of their own. Uploaded images, AI-generated avatars, and "no avatar" all
 * return null here, so nothing downstream can derive an icon from them, and a
 * character state with malformed traits returns null rather than a name built
 * from `undefined`. A character's traits always carry all three, so the guard
 * stays whole even though the name is built from two of them.
 *
 * A user with any avatar can still pick an icon by hand; this function answers
 * only what the avatar itself maps to.
 */
export function appIconNameForAvatar(state: AvatarState | null): string | null {
  if (state === null || state.kind !== "character") {
    return null;
  }
  const traits = state.traits;
  if (!isCharacterTraits(traits)) {
    return null;
  }
  return appIconNameForTraits(traits.eyeStyle, traits.color);
}

/**
 * True when the applied icon is one this feature put there, whatever the
 * avatar says today. The applied name is the only record that anything was ever
 * swapped, since nothing here resets an icon on its own, so this is what lets
 * {@link traitsForAppIconName} read a pair back out of it and what keeps
 * Settings previewing the icon a user chose after their avatar moves on.
 */
export function isAvatarAppIcon(name: string | null): boolean {
  return name !== null && name.startsWith(AVATAR_ICON_PREFIX);
}

/**
 * Read an applied icon name back into the pair it was composed from, the
 * inverse of {@link appIconNameForTraits}. The picker opens on whatever is
 * already on the home screen, and this is what tells it which pair that is.
 *
 * The seam is the first dash after the prefix, because eye style ids carry
 * none of their own while color ids may, so a color like `cosmic-purple`
 * survives the round trip. Any name this feature did not compose, the default
 * icon included, reads as null and callers fall back to a pair of their own.
 */
export function traitsForAppIconName(
  name: string | null,
): AppIconTraits | null {
  if (name === null || !isAvatarAppIcon(name)) {
    return null;
  }
  const pair = name.slice(AVATAR_ICON_PREFIX.length);
  const seam = pair.indexOf("-");
  if (seam <= 0 || seam === pair.length - 1) {
    return null;
  }
  return { eyeStyle: pair.slice(0, seam), color: pair.slice(seam + 1) };
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
