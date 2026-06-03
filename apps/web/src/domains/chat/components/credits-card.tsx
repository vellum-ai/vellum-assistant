import { Button } from "@vellum/design-library";
import { Coins, Gift, Plus } from "lucide-react";

interface CreditsCardProps {
  /** Formatted whole-credits string, or null when unavailable. */
  balance: string | null;
  onAddCredits: () => void;
  onEarnCredits: () => void;
}

/**
 * Presentational credits card matching the iOS preferences-drawer mock:
 * a bordered card containing a credits pill (coins icon + balance + a primary
 * "Add" button) and an "Earn Credits" row beneath. Purely presentational — no
 * data fetching; callers supply the formatted balance and handlers.
 */
export function CreditsCard({
  balance,
  onAddCredits,
  onEarnCredits,
}: CreditsCardProps) {
  return (
    <div
      className="flex flex-col gap-4 rounded-lg border px-3 pt-3 pb-4 w-full"
      style={{
        borderColor: "var(--surface-base)",
        background: "var(--surface-overlay)",
      }}
    >
      {balance !== null && (
        <div
          className="flex items-center justify-between gap-2 rounded-[10px] py-2 pl-1.5 pr-2 w-full"
          style={{ background: "var(--surface-base)" }}
        >
          <div className="flex items-center gap-2">
            <Coins
              className="h-3.5 w-3.5"
              style={{ color: "var(--credits-accent)" }}
              aria-hidden
            />
            <span
              className="text-body-large-default max-md:text-title-medium"
              style={{ color: "var(--content-default)" }}
            >
              {balance} credits
            </span>
          </div>
          <Button variant="primary" size="regular" onClick={onAddCredits}>
            <Plus className="h-3 w-3" aria-hidden />
            Add
          </Button>
        </div>
      )}

      <button
        type="button"
        onClick={onEarnCredits}
        className="flex items-center justify-center gap-2 transition-colors hover:opacity-80"
      >
        <Gift
          className="h-3.5 w-3.5"
          style={{ color: "var(--content-secondary)" }}
          aria-hidden
        />
        <span
          className="text-body-medium-lighter max-md:text-body-large-default"
          style={{ color: "var(--content-secondary)" }}
        >
          Earn Credits
        </span>
      </button>
    </div>
  );
}
