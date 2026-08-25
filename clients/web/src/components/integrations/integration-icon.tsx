import { useState } from "react";

import { GoogleLogo } from "@/components/icons/google-logo";
import { publicAsset } from "@/utils/public-asset";

/**
 * Logos we ship in `public/`, keyed by canonical provider key.
 *
 * Covers every provider in `PROVIDER_SEED_DATA` (Google is handled separately
 * below, as its mark is multi-colour and ships as a component), so no
 * first-class integration hits the network to draw its icon.
 *
 * These take precedence over the provider's seeded `logoUrl`, which points at
 * a third-party icon CDN. Icon libraries drop brands on trademark request:
 * Simple Icons hosts no Microsoft mark and no Slack mark, so those `logoUrl`
 * values 404 and a remote-first lookup would strand those rows on an initials
 * avatar. A bundled asset can't 404, needs no network, and doesn't tell a
 * third party which integrations a user is looking at.
 *
 * `logoUrl` remains the fallback below for providers registered at runtime,
 * which are not in this map.
 *
 * Sources and licences: `ATTRIBUTION.md` beside the assets.
 */
const BUNDLED_LOGO_URLS: Record<string, string> = {
  airtable: publicAsset("/images/integrations/airtable.svg"),
  asana: publicAsset("/images/integrations/asana.svg"),
  calendly: publicAsset("/images/integrations/calendly.svg"),
  discord: publicAsset("/images/integrations/discord.svg"),
  discord_channel: publicAsset("/images/integrations/discord.svg"),
  dropbox: publicAsset("/images/integrations/dropbox.svg"),
  eventbrite: publicAsset("/images/integrations/eventbrite.svg"),
  figma: publicAsset("/images/integrations/figma.svg"),
  github: publicAsset("/images/integrations/github.svg"),
  hubspot: publicAsset("/images/integrations/hubspot.svg"),
  linear: publicAsset("/images/integrations/linear-light-logo.svg"),
  monday: publicAsset("/images/integrations/monday.svg"),
  notion: publicAsset("/images/integrations/notion.svg"),
  outlook: publicAsset("/images/integrations/outlook.png"),
  salesforce: publicAsset("/images/integrations/salesforce.svg"),
  sanity: publicAsset("/images/integrations/sanity.svg"),
  slack: publicAsset("/images/integrations/slack.svg"),
  slack_channel: publicAsset("/images/integrations/slack.svg"),
  spotify: publicAsset("/images/integrations/spotify.svg"),
  telegram: publicAsset("/images/integrations/telegram.svg"),
  todoist: publicAsset("/images/integrations/todoist.svg"),
  twitter: publicAsset("/images/integrations/x.svg"),
};

// Deterministic avatar palette. Each slot is a distinct hue so adjacent
// integrations read as visually different. This is a purely decorative
// avatar treatment (not success/error/warning semantics), so we use a
// consistent set of Tailwind accent colors rather than mixing semantic
// system tokens with accent classes.
const PALETTE = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
];

function colorForKey(providerKey: string): string {
  let sum = 0;
  for (let i = 0; i < providerKey.length; i += 1) {
    sum = (sum + providerKey.charCodeAt(i)) % Number.MAX_SAFE_INTEGER;
  }
  return PALETTE[sum % PALETTE.length] ?? PALETTE[0]!;
}

interface IntegrationIconProps {
  providerKey: string;
  displayName: string | null;
  logoUrl: string | null;
  size?: number;
}

export function IntegrationIcon({
  providerKey,
  displayName,
  logoUrl,
  size = 32,
}: IntegrationIconProps) {
  // Sources that have 404'd (or otherwise failed to decode) this mount. Keyed
  // by URL rather than a boolean so a failing bundled asset falls through to
  // the remote `logoUrl` instead of skipping straight to the initials avatar.
  const [failedSources, setFailedSources] = useState<readonly string[]>([]);
  const normalizedProviderKey = providerKey.toLowerCase();
  const name = displayName ?? providerKey;
  const initials = name.slice(0, 2).toUpperCase();
  const bgColor = colorForKey(providerKey);

  if (normalizedProviderKey === "google") {
    return (
      <GoogleLogo
        size={size}
        className="shrink-0 rounded-md object-contain"
        style={{ width: size, height: size }}
      />
    );
  }

  const candidates = [BUNDLED_LOGO_URLS[normalizedProviderKey], logoUrl].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const effectiveLogoUrl = candidates.find(
    (candidate) => !failedSources.includes(candidate),
  );

  if (effectiveLogoUrl) {
    return (
      <img
        // Remount on source change so a failed load doesn't leave the previous
        // source's broken-image state painted over the fallback.
        key={effectiveLogoUrl}
        src={effectiveLogoUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-md object-contain"
        onError={() =>
          setFailedSources((previous) =>
            previous.includes(effectiveLogoUrl)
              ? previous
              : [...previous, effectiveLogoUrl],
          )
        }
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bgColor}`}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
