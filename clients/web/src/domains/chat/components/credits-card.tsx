import { Button } from "@vellumai/design-library";
import { Coins, Plus } from "lucide-react";

interface CreditsCardProps {
  /** Formatted whole-credits string, or null when unavailable. */
  balance: string | null;
  onAddCredits: () => void;
}

/**
 * Presentational credits card matching the preferences-drawer mock: a single
 * slim flat container with the coins icon + balance on the left and a ghost
 * "Credits" button (plus icon) on the right. No nested background — the container
 * is the only surface. Purely presentational; callers supply the formatted
 * balance and handler.
 *
 * Renders nothing when `balance` is null (unavailable / still loading) so the
 * container never shows up empty.
 */
export function CreditsCard({ balance, onAddCredits }: CreditsCardProps) {
  if (balance === null) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-base)] py-2 pl-2.5 pr-1.5 w-full">
      <div className="flex items-center gap-2">
        <Coins
          className="h-3.5 w-3.5 text-[color:var(--credits-accent)]"
          aria-hidden
        />
        <span
          className="text-body-medium-default font-normal! max-md:text-title-medium text-[color:var(--content-default)]"
          aria-label={`${balance} credits`}
        >
          {balance} c
        </span>
      </div>
      {/*
       * size="regular" gives the label `text-body-medium-default`, matching
       * the balance's line-height so the two are optically centered (the
       * compact token uses line-height:1, which floats the small label). We
       * keep the slim height/padding via className, and tighten the
       * icon↔label gap from the base `gap-1.5` to `gap-1` for this button only
       * (overriding the shared Button default without affecting other buttons).
       */}
      <Button
        variant="ghost"
        size="regular"
        onClick={onAddCredits}
        className="h-6 gap-1 px-1.5 font-normal!"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Credits
      </Button>
    </div>
  );
}
