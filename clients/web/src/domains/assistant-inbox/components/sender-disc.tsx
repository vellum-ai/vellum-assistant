import { cn } from "@vellumai/design-library";

import type { EmailParticipant } from "../types";

/**
 * Theme-aware washes, one per bucket. Hashing the address into this list
 * keeps a sender's colour stable across the list, the reading pane, and a
 * reload, without storing anything.
 */
const WASHES = [
  "bg-[var(--accent-orange-weak)]",
  "bg-[var(--accent-purple-weak)]",
  "bg-[var(--system-info-weak)]",
  "bg-[var(--system-positive-weak)]",
  "bg-[var(--system-mid-weak)]",
] as const;

function washFor(address: string): string {
  let hash = 0;
  for (const char of address.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return WASHES[hash % WASHES.length]!;
}

function initialFor(participant: EmailParticipant): string {
  const source = participant.name?.trim() || participant.address;
  const first = source.match(/\p{L}|\p{N}/u);
  return (first?.[0] ?? "?").toUpperCase();
}

export interface SenderDiscProps {
  participant: EmailParticipant;
  size?: number;
  className?: string;
}

/**
 * A round monogram for a correspondent: the first letter of their name (or
 * address) on a soft wash keyed to the address. Decorative; the row beside it
 * carries the name.
 */
export function SenderDisc({
  participant,
  size = 36,
  className,
}: SenderDiscProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-medium text-[var(--content-default)]",
        washFor(participant.address),
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initialFor(participant)}
    </span>
  );
}
