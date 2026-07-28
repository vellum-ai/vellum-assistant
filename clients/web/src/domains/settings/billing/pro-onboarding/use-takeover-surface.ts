import { useMemo } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { resolveAvatarAccentHex } from "@/hooks/use-avatar-accent-var";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SURFACE_GROUND, avatarSurfaceHex } from "@/utils/avatar-tone";

import {
  readTakeoverAvatarStash,
  takeoverAvatarStashVersion,
} from "./takeover-avatar-stash";

/**
 * The avatar payload the takeover draws: the live query's once it lands, or the
 * stash captured at the Stripe hand-off while it resolves.
 * Ungated: every field carries whatever was chosen right now, so a consumer
 * must render it only inside a {@link TakeoverSurface.ready} branch.
 */
export interface TakeoverAvatarInputs {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  /** The assistant's uploaded image, drawn as the avatar in place of an SVG. */
  customImageUrl: string | null;
}

export interface TakeoverSurface {
  /** Opaque #rrggbb to paint the takeover and its exit sheet. */
  tintHex: string;
  /**
   * Ready-gated custom avatar image to blur behind the content, when there is
   * one — the background wash, not the avatar. The avatar's own image is
   * {@link TakeoverAvatarInputs.customImageUrl}.
   */
  backdropImageUrl: string | null;
  /** Safe to draw: the avatar query settled, or a usable stash stands in. */
  ready: boolean;
  /** Render inputs for the avatar, valid only once `ready`. */
  avatar: TakeoverAvatarInputs;
}

/**
 * The single resolution of the provisioning takeover's avatar: which assistant
 * it draws, that avatar's render inputs, and the paint derived from it — a deep
 * tint of the character accent, or the custom image to blur behind the content.
 *
 * Three tiers decide what is drawable, in order: the live avatar query once it
 * settles with data, else the stash captured at the Stripe hand-off (only for
 * the same assistant), else nothing. Withholding matters because `ChatAvatar`
 * synthesizes fallback traits from the first bundled color, so drawing an
 * unknown avatar paints green and then jumps to the assistant's real color at
 * full-viewport scale. Until something is drawable the surface stays on the
 * hue-neutral {@link SURFACE_GROUND}.
 */
export function useTakeoverSurface(
  assistantId?: string | null,
): TakeoverSurface {
  const activeId = useResolvedAssistantsStore.use.activeAssistantId();
  // An explicit null is the provisioning hook saying it does not know the
  // target yet — it withholds `primary_assistant_id` until onboarding is fresh,
  // so a multi-assistant org must not aim at the active assistant. Only an
  // omitted prop falls back to active.
  const resolvedId = assistantId === undefined ? activeId : assistantId;
  const { components, traits, customImageUrl, isLoading } =
    useAssistantAvatar(resolvedId);
  // Tracking the version, not just mounting once: native checkout opens an
  // external browser without unloading the page, so the billing modal hosting
  // this hook is already mounted when the stash is written. Re-reading on the
  // takeover's open flip is enough; no subscription needed.
  const stashVersion = takeoverAvatarStashVersion();
  // Memoized so a sessionStorage re-parse can't hand the avatar a new
  // `components` identity every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the version IS the dep; it stands in for the module state the read touches
  const stash = useMemo(() => readTakeoverAvatarStash(), [stashVersion]);

  // `useAssistantAvatar(null)` is a disabled query, which reports
  // `isLoading: false` with no data, so the id has to gate settling too.
  const liveSettled = resolvedId != null && !isLoading;
  // While the provisioning hook has not named a target the stash may stand in,
  // safe because a stash is only ever captured in a single-assistant org, so
  // there is no second creature the unresolved target could turn out to be.
  // Once a target does resolve, only a matching stash may draw.
  const stashUsable =
    stash != null && (resolvedId == null || resolvedId === stash.assistantId);
  const liveDrawable =
    liveSettled &&
    (components != null || traits != null || customImageUrl != null);
  // Live data wins the moment it lands. A settle that comes back empty (the
  // daemon erroring while the machine restarts) keeps the stash, which is
  // strictly more truthful than the bundled-green fallback.
  const drawnStash = stashUsable && !liveDrawable ? stash : null;

  const effectiveComponents = drawnStash ? drawnStash.components : components;
  const effectiveTraits = drawnStash ? drawnStash.traits : traits;
  // The stash never carries an image: a blob URL is dead after the reload.
  const effectiveCustomImageUrl = drawnStash ? null : customImageUrl;
  const ready = liveSettled || stashUsable;

  const accent =
    resolveAvatarAccentHex(effectiveComponents, effectiveTraits) ??
    // ChatAvatar draws from `components ?? bundled`, so the surface tints from
    // the same source it does — the first bundled color when the query settles
    // with none — and matches whatever creature is on screen instead of falling
    // through to neutral.
    (effectiveCustomImageUrl
      ? null
      : ((effectiveComponents ?? BUNDLED_COMPONENTS).colors?.[0]?.hex ?? null));

  return {
    tintHex: ready && accent ? avatarSurfaceHex(accent) : SURFACE_GROUND,
    // The stash carries no image, so only a live settle can supply a backdrop.
    backdropImageUrl: liveSettled ? customImageUrl : null,
    ready,
    avatar: {
      components: effectiveComponents,
      traits: effectiveTraits,
      customImageUrl: effectiveCustomImageUrl,
    },
  };
}
