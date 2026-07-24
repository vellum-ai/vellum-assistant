import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { resolveAvatarAccentHex } from "@/hooks/use-avatar-accent-var";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SURFACE_GROUND, avatarSurfaceHex } from "@/utils/avatar-tone";

/**
 * The target assistant's raw avatar payload, for drawing the creature itself.
 * Ungated: every field carries whatever the query holds right now, so a
 * consumer must render it only inside a {@link TakeoverSurface.ready} branch.
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
  /** The target resolved and its avatar query settled — safe to draw. */
  ready: boolean;
  /** Render inputs for the avatar, valid only once `ready`. */
  avatar: TakeoverAvatarInputs;
}

/**
 * The single resolution of the provisioning takeover's avatar: which assistant
 * it draws, that avatar's render inputs, and the paint derived from it — a deep
 * tint of the character accent, or the custom image to blur behind the content.
 *
 * The surface stays on the hue-neutral {@link SURFACE_GROUND} and withholds the
 * avatar until the query settles. `ChatAvatar` synthesizes fallback traits from
 * the first bundled color, so drawing before the fetch resolves paints green
 * and then jumps to the assistant's real color at full-viewport scale.
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
  // `useAssistantAvatar(null)` is a disabled query, which reports
  // `isLoading: false` with no data, so the id has to gate readiness too.
  const ready = resolvedId != null && !isLoading;

  const accent =
    resolveAvatarAccentHex(components, traits) ??
    // ChatAvatar draws from `components ?? bundled`, so the surface tints from
    // the same source it does — the first bundled color when the query settles
    // with none — and matches whatever creature is on screen instead of falling
    // through to neutral.
    (customImageUrl
      ? null
      : ((components ?? BUNDLED_COMPONENTS).colors?.[0]?.hex ?? null));

  return {
    tintHex: ready && accent ? avatarSurfaceHex(accent) : SURFACE_GROUND,
    backdropImageUrl: ready ? customImageUrl : null,
    ready,
    avatar: { components, traits, customImageUrl },
  };
}
