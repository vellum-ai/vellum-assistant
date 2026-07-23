import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { resolveAvatarAccentHex } from "@/hooks/use-avatar-accent-var";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { SURFACE_GROUND, avatarSurfaceHex } from "@/utils/avatar-tone";

export interface TakeoverSurface {
  /** Opaque #rrggbb to paint the takeover and its exit sheet. */
  tintHex: string;
  /** Custom avatar image to blur behind the content, when there is one. */
  backdropImageUrl: string | null;
  /** The avatar query has settled — safe to commit to a hue. */
  ready: boolean;
}

/**
 * The paint for the provisioning takeover, derived from the target assistant's
 * avatar: a deep tint of the character accent, or the custom image to blur
 * behind the content.
 *
 * The surface stays on the hue-neutral {@link SURFACE_GROUND} until the avatar
 * query settles. `ChatAvatar` synthesizes fallback traits from the first
 * bundled color, so a surface derived before the fetch resolves would paint
 * green and then jump to the assistant's real color at full-viewport scale.
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
    // With no traits and no image, ChatAvatar draws the first bundled color, so
    // the surface matches that creature rather than falling through to neutral.
    (customImageUrl ? null : (components?.colors[0]?.hex ?? null));

  return {
    tintHex: ready && accent ? avatarSurfaceHex(accent) : SURFACE_GROUND,
    backdropImageUrl: ready ? customImageUrl : null,
    ready,
  };
}
