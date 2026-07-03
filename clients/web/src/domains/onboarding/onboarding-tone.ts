/**
 * Foreground tone for the avatar-tinted onboarding steps.
 *
 * SPIKE — research-onboarding flow.
 *
 * Those steps paint the background with the chosen avatar's color, so UI drawn
 * on top (top bar, titles, labels) needs a foreground that contrasts: white on
 * the dark/saturated colors, black on the light one (yellow). This derives that
 * once from the chosen color's perceived brightness, so every surface can read
 * the same `fg`/`fgMuted` instead of hard-coding white.
 *
 * The picker / first form sit on the dark app surface (not an avatar color) and
 * should stay white regardless — they pass an explicit tone rather than using
 * this hook.
 */

import { useMemo } from "react";

import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

export interface OnboardingTone {
  /** Background hex (the chosen avatar color), or the app surface fallback. */
  bg: string;
  /** True when the background is light enough to need dark foreground. */
  isLight: boolean;
  /** Foreground color: black on light bg, white otherwise. */
  fg: string;
  /**
   * A deeper heading foreground: the background color itself, darkened. Shared
   * by the "Hey {name}" greeting and the pitch setup line so they read as the
   * same secondary tone.
   */
  fgDeep: string;
  /** Muted/secondary foreground at the matching tone. */
  fgMuted: string;
  /** A subtle hover/fill wash at the matching tone. */
  wash: string;
}

const FG_DARK = "#1A1A1A";
const FG_LIGHT = "#FFFFFF";

/** Perceived brightness (YIQ), 0–1. */
function brightness(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/** Multiply each channel of a #rrggbb hex by `factor` (clamped 0–255). */
function darkenHex(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((n >> shift) & 0xff) * factor)));
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** Build a tone object from a background hex. */
export function toneForBg(bg: string): OnboardingTone {
  const isLight = brightness(bg) > 0.6;
  return {
    bg,
    isLight,
    fg: isLight ? FG_DARK : FG_LIGHT,
    fgDeep: darkenHex(bg, 0.6),
    fgMuted: isLight ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)",
    wash: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
  };
}

/** Tone derived from the currently-chosen avatar's color. */
export function useOnboardingTone(): OnboardingTone {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  return useMemo(() => {
    const chosen = characters[selectedIndex];
    const hex = components?.colors.find((c) => c.id === chosen?.color)?.hex;
    return toneForBg(hex ?? "var(--surface-base)");
  }, [components, characters, selectedIndex]);
}
