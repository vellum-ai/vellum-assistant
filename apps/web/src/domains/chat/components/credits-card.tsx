import { Button } from "@vellum/design-library";
import { Coins, Plus } from "lucide-react";

interface CreditsCardProps {
  /** Formatted whole-credits string, or null when unavailable. */
  balance: string | null;
  onAddCredits: () => void;
}

/**
 * Presentational credits card matching the iOS preferences-drawer mock:
 * a slim bordered card containing a single credits pill (coins icon + balance
 * + a primary "Add" button). Purely presentational — no data fetching; callers
 * supply the formatted balance and handler.
 */
export function CreditsCard({ balance, onAddCredits }: CreditsCardProps) {
  return (
    <div className="flex flex-col rounded-lg border border-[var(--surface-base)] bg-[var(--surface-overlay)] p-2 w-full">
      {balance !== null && (
        <div className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--surface-base)] py-2 pl-1.5 pr-2 w-full">
          <div className="flex items-center gap-2">
            <Coins
              className="h-3.5 w-3.5 text-[color:var(--credits-accent)]"
              aria-hidden
            />
            <span className="text-body-medium-default max-md:text-title-medium text-[color:var(--content-default)]">
              {balance} credits
            </span>
          </div>
          {/*
           * Compact on desktop (size="compact"); the mobile mock keeps the
           * larger regular button, so override the compact dimensions back to
           * regular at max-md. (Button `size` is a prop, not a responsive
           * class, so the breakpoint swap lives in className.)
           */}
          <Button
            variant="primary"
            size="compact"
            onClick={onAddCredits}
            className="max-md:h-8 max-md:rounded-md max-md:px-2.5 max-md:text-body-medium-default"
          >
            <Plus className="h-3 w-3" aria-hidden />
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
