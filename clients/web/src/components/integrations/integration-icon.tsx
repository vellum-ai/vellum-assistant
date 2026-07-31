import { useState } from "react";

import { GoogleLogo } from "@/components/icons/google-logo";
import { publicAsset } from "@/utils/public-asset";

const KNOWN_LOGO_URLS: Record<string, string> = {
  github: publicAsset("/images/integrations/github.svg"),
  linear: publicAsset("/images/integrations/linear-light-logo.svg"),
  notion: publicAsset("/images/integrations/notion.svg"),
  outlook: publicAsset("/images/integrations/outlook.png"),
  slack: publicAsset("/images/integrations/slack.svg"),
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
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedProviderKey = providerKey.toLowerCase();
  const effectiveLogoUrl = logoUrl ?? KNOWN_LOGO_URLS[normalizedProviderKey];
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

  if (effectiveLogoUrl && !imageFailed) {
    return (
      <img
        src={effectiveLogoUrl}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-md object-contain"
        onError={() => setImageFailed(true)}
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
