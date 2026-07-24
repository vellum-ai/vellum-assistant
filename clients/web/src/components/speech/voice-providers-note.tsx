/**
 * The fine print under a voice picker: everything the picker deliberately
 * doesn't offer — providers, transcription, API keys — lives on Models &
 * Services. Shared so the first-run card's Voices view and
 * {@link VoicePickerModal} carry the same sentence and the same link target
 * rather than two drifting copies.
 *
 * Safe to click mid-call: leaving the chat route hides the voice room (see
 * `useIsVoiceRoomVisible`) and hands the live session to the title-bar pill —
 * the call keeps running while the user is in Settings.
 */

import { Link } from "react-router";

import { cn } from "@vellumai/design-library";

import { routes } from "@/utils/routes";

export function VoiceProvidersNote({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "text-label-small-default text-[var(--content-tertiary)]",
        className,
      )}
    >
      Speech providers, transcription, and API keys live in{" "}
      <Link
        to={`${routes.settings.ai}#text-to-speech`}
        className="text-[var(--content-secondary)] underline decoration-[var(--border-element)] underline-offset-2 hover:text-[var(--content-default)]"
      >
        Models &amp; Services
      </Link>
      .
    </p>
  );
}
