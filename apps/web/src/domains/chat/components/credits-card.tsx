import { Button } from "@vellum/design-library";
import { Coins, Plus } from "lucide-react";

interface CreditsCardProps {
  /** Formatted whole-credits string, or null when unavailable. */
  balance: string | null;
  onAddCredits: () => void;
}

/**
 * Presentational credits card matching the preferences-drawer mock: a single
 * slim flat container with the coins icon + balance on the left and a ghost
 * "Add" button (plus icon) on the right. No nested background — the container
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
    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--surface-base)] bg-[var(--surface-overlay)] py-2 pl-2.5 pr-1.5 w-full">
      <div className="flex items-center gap-2">
        <Coins
          className="h-3.5 w-3.5 text-[color:var(--credits-accent)]"
          aria-hidden
        />
        <span className="text-body-medium-default max-md:text-title-medium text-[color:var(--content-default)]">
          {balance} credits
        </span>
      </div>
      <Button
        variant="ghost"
        size="compact"
        onClick={onAddCredits}
        className="max-md:text-body-medium-default"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add
      </Button>
    </div>
  );
}
