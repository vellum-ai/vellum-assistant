import { Sparkles } from "lucide-react";

import { GmailLogo } from "@/components/icons/gmail-logo";
import { GoogleCalendarLogo } from "@/components/icons/google-calendar-logo";
import { GoogleDriveLogo } from "@/components/icons/google-drive-logo";
import type { SuggestionIconKey } from "@/domains/chat/suggestions/types";

/**
 * Maps a {@link SuggestionIconKey} to a rendered brand/lucide icon. Unknown
 * keys fall back to the generic Sparkles mark.
 */
export function SuggestionIcon({
  iconKey,
  size = 28,
}: {
  iconKey: SuggestionIconKey;
  size?: number;
}) {
  switch (iconKey) {
    case "gmail":
      return <GmailLogo size={size} />;
    case "google-calendar":
      return <GoogleCalendarLogo size={size} />;
    case "google-drive":
      return <GoogleDriveLogo size={size} />;
    case "vellum":
      return (
        <Sparkles size={size} aria-hidden className="text-[var(--primary-base)]" />
      );
    default:
      return (
        <Sparkles
          size={size}
          aria-hidden
          className="text-[var(--content-secondary)]"
        />
      );
  }
}
