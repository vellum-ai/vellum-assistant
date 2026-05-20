import { useState } from "react";

/**
 * Renders an icon for an integration provider.
 *
 * When `logoUrl` is provided and loads successfully, the image is shown.
 * Otherwise (or while loading), an initials avatar is rendered with a
 * deterministic background color derived from the provider key.
 *
 * This mirrors the macOS desktop app's `IntegrationIcon` component so that
 * web and desktop render visually equivalent integration icons.
 */

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
  const name = displayName ?? providerKey;
  const initials = name.slice(0, 2).toUpperCase();
  const bgColor = colorForKey(providerKey);

  if (logoUrl && !imageFailed) {
    return (
      <img
        src={logoUrl}
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
      // Decorative avatar initials sized proportionally to `size` via inline
      // style (40% of px size); the canonical token scale has no variant for
      // this dynamic sizing so we keep the ad-hoc font weight.
      className={ /* typography: off-scale — dynamic sizing via inline style */ `flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bgColor}`}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
