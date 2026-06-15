/**
 * Chunky flat-fill prop art — drawn in the dudes' visual language: bold solid
 * fills, rounded forms, white/black accents, no outline strokes or gradients
 * (a couple of inherently-tubular props use a round-capped stroke as the shape
 * itself, e.g. the headset band and stethoscope tubing). One drawing per prop,
 * reused at tile size and as the larger flying/held prop.
 *
 * Ported from the prototype's `@/cast/cast-prop-art`. The `PropKey` union was
 * already inlined into `cast-content` on base (it keys job/rather icons there),
 * so this module imports + re-exports it from `cast-content` rather than
 * redeclaring it — the art table is the only new surface. Needed by the done
 * screen's proof view (`cast-proof-view`) for held/juggled/artifact prop icons.
 */

import type { ReactNode } from "react";

import type { PropKey } from "@/domains/onboarding/cast/cast-content";

export type { PropKey };

// Shared palette — the dude colors plus a few prop neutrals.
const INK = "#1A1A1A";
const PAPER = "#F2F2F2";
const GREEN = "#4C9B50";
const ORANGE = "#E9642F";
const PINK = "#DB4B77";
const PURPLE = "#A665C9";
const TEAL = "#0E9B8B";
const YELLOW = "#E9C91A";
const METAL = "#C7CDD6";
const DARK_METAL = "#5B6270";
const SLATE = "#3A3F4D";
const WOOD = "#C8863E";
const WOOD_DARK = "#9C6526";

const ART: Record<PropKey, ReactNode> = {
  laptop: (
    <>
      <rect x="20" y="26" width="80" height="54" rx="10" fill={INK} />
      <rect x="28" y="33" width="64" height="40" rx="6" fill={TEAL} />
      <rect x="34" y="39" width="20" height="6" rx="3" fill="#3fcbb8" />
      <rect x="8" y="80" width="104" height="16" rx="8" fill={SLATE} />
      <rect x="48" y="84" width="24" height="5" rx="2.5" fill={DARK_METAL} />
    </>
  ),
  pen: (
    <g transform="rotate(-38 60 60)">
      <rect x="50" y="14" width="20" height="66" rx="10" fill={ORANGE} />
      <rect x="50" y="14" width="20" height="12" rx="6" fill="#b94413" />
      <rect x="72" y="22" width="6" height="26" rx="3" fill="#b94413" />
      <polygon points="50,80 70,80 60,104" fill={INK} />
      <polygon points="57,97 63,97 60,104" fill={PAPER} />
    </g>
  ),
  brush: (
    <g transform="rotate(-38 60 60)">
      <rect x="52" y="10" width="16" height="56" rx="8" fill={WOOD} />
      <rect x="50" y="62" width="20" height="14" rx="4" fill={METAL} />
      <path d="M50 76 H70 L66 104 Q60 112 54 104 Z" fill={PINK} />
    </g>
  ),
  headset: (
    <>
      <path
        d="M26 70 V58 A34 34 0 0 1 94 58 V70"
        fill="none"
        stroke={PURPLE}
        strokeWidth="12"
        strokeLinecap="round"
      />
      <rect x="16" y="62" width="22" height="34" rx="11" fill={INK} />
      <rect x="22" y="69" width="10" height="20" rx="5" fill={PURPLE} />
      <rect x="82" y="62" width="22" height="34" rx="11" fill={INK} />
      <rect x="88" y="69" width="10" height="20" rx="5" fill={PURPLE} />
      <path d="M27 92 Q27 104 46 104" fill="none" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <circle cx="48" cy="104" r="6" fill={INK} />
    </>
  ),
  clipboard: (
    <>
      <rect x="22" y="16" width="76" height="94" rx="11" fill={WOOD} />
      <rect x="32" y="28" width="56" height="74" rx="5" fill={PAPER} />
      <rect x="40" y="40" width="40" height="6" rx="3" fill="#D2D6DE" />
      <rect x="40" y="54" width="40" height="6" rx="3" fill="#D2D6DE" />
      <rect x="40" y="68" width="28" height="6" rx="3" fill="#D2D6DE" />
      <rect x="46" y="8" width="28" height="18" rx="6" fill={DARK_METAL} />
    </>
  ),
  book: (
    <>
      <rect x="26" y="24" width="70" height="74" rx="9" fill={PINK} />
      <rect x="26" y="24" width="13" height="74" rx="6" fill="#b23a62" />
      <rect x="84" y="30" width="10" height="62" rx="3" fill={PAPER} />
      <rect x="62" y="20" width="11" height="34" rx="2" fill={YELLOW} />
    </>
  ),
  stethoscope: (
    <>
      <path
        d="M40 22 V44 Q40 74 60 74 Q80 74 80 44 V22"
        fill="none"
        stroke={TEAL}
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle cx="40" cy="20" r="7" fill={INK} />
      <circle cx="80" cy="20" r="7" fill={INK} />
      <path d="M60 74 V90" fill="none" stroke={TEAL} strokeWidth="9" strokeLinecap="round" />
      <circle cx="60" cy="98" r="15" fill={METAL} />
      <circle cx="60" cy="98" r="7" fill={DARK_METAL} />
    </>
  ),
  hammer: (
    <>
      <path d="M24 24 H84 V44 H58 L50 36 H24 Z" fill={DARK_METAL} />
      <rect x="24" y="24" width="14" height="20" rx="3" fill={METAL} />
      <rect x="52" y="40" width="16" height="64" rx="8" fill={WOOD} />
      <rect x="52" y="40" width="16" height="64" rx="8" fill={WOOD} />
      <rect x="54" y="86" width="12" height="18" rx="5" fill={WOOD_DARK} />
    </>
  ),
  sunglasses: (
    <>
      <rect x="16" y="46" width="38" height="30" rx="13" fill={INK} />
      <rect x="66" y="46" width="38" height="30" rx="13" fill={INK} />
      <rect x="50" y="52" width="20" height="9" rx="4" fill={INK} />
      <rect x="6" y="50" width="14" height="8" rx="4" fill={INK} transform="rotate(18 13 54)" />
      <rect x="100" y="50" width="14" height="8" rx="4" fill={INK} transform="rotate(-18 107 54)" />
      <rect x="22" y="51" width="11" height="7" rx="3.5" fill="#5b6270" />
      <rect x="72" y="51" width="11" height="7" rx="3.5" fill="#5b6270" />
    </>
  ),
  backpack: (
    <>
      <rect x="34" y="20" width="14" height="26" rx="7" fill="#3c7d40" />
      <rect x="72" y="20" width="14" height="26" rx="7" fill="#3c7d40" />
      <rect x="24" y="30" width="72" height="78" rx="22" fill={GREEN} />
      <rect x="40" y="40" width="40" height="18" rx="9" fill="#3c7d40" />
      <rect x="38" y="64" width="44" height="38" rx="13" fill="#3c7d40" />
      <rect x="56" y="70" width="8" height="22" rx="4" fill={YELLOW} />
    </>
  ),
  chefhat: (
    <>
      <rect x="38" y="74" width="44" height="30" rx="7" fill="#E2E2E2" />
      <circle cx="42" cy="52" r="20" fill={PAPER} />
      <circle cx="78" cy="52" r="20" fill={PAPER} />
      <circle cx="60" cy="42" r="25" fill={PAPER} />
      <rect x="36" y="56" width="48" height="26" fill={PAPER} />
    </>
  ),
  gamepad: (
    <>
      <circle cx="34" cy="78" r="20" fill={SLATE} />
      <circle cx="86" cy="78" r="20" fill={SLATE} />
      <rect x="22" y="46" width="76" height="36" rx="18" fill={SLATE} />
      <rect x="33" y="60" width="18" height="6" rx="3" fill={PAPER} />
      <rect x="39" y="54" width="6" height="18" rx="3" fill={PAPER} />
      <circle cx="76" cy="60" r="5" fill={PINK} />
      <circle cx="88" cy="64" r="5" fill={YELLOW} />
      <circle cx="76" cy="72" r="5" fill={TEAL} />
    </>
  ),
  plane: (
    <g transform="rotate(38 60 60)">
      <rect x="53" y="20" width="14" height="80" rx="7" fill={PAPER} />
      <polygon points="60,44 102,70 60,60 18,70" fill={PAPER} />
      <polygon points="60,92 76,104 60,100 44,104" fill={PAPER} />
      <circle cx="60" cy="30" r="6" fill={TEAL} />
      <rect x="55" y="62" width="10" height="6" rx="3" fill={TEAL} />
    </g>
  ),
  moon: (
    <>
      <path d="M78 30 A34 34 0 1 0 78 90 A26 26 0 1 1 78 30 Z" fill={YELLOW} />
      <circle cx="86" cy="34" r="4" fill={PAPER} />
      <circle cx="96" cy="52" r="3" fill={PAPER} />
      <circle cx="84" cy="64" r="2.5" fill={PAPER} />
    </>
  ),
  buddies: (
    <>
      <path d="M22 96 Q22 56 46 56 Q70 56 70 96 Z" fill={TEAL} />
      <circle cx="38" cy="74" r="5" fill={PAPER} />
      <circle cx="54" cy="74" r="5" fill={PAPER} />
      <circle cx="38" cy="74" r="2.4" fill={INK} />
      <circle cx="54" cy="74" r="2.4" fill={INK} />
      <path d="M62 98 Q62 62 84 62 Q106 62 106 98 Z" fill={PINK} />
      <circle cx="78" cy="80" r="4.5" fill={PAPER} />
      <circle cx="92" cy="80" r="4.5" fill={PAPER} />
      <circle cx="78" cy="80" r="2.2" fill={INK} />
      <circle cx="92" cy="80" r="2.2" fill={INK} />
    </>
  ),
};

export function CastProp({ name, className }: { name: PropKey; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" aria-hidden="true">
      {ART[name]}
    </svg>
  );
}
