import { Button } from "@vellumai/design-library";
import { Coins, Plus } from "lucide-react";
import { useTranslation } from "@/i18n";

interface CreditsCardProps {
  /** Formatted whole-credits string, or null when unavailable. */
  balance: string | null;
  onAddCredits?: () => void;
}

/**
 * Presentational credits card with the balance on the left and an optional
 * "Credits" action on the right. The container is the only surface. Callers
 * supply the formatted balance and, where purchases are supported, a handler.
 *
 * Renders nothing when `balance` is null (unavailable / still loading) so the
 * container never shows up empty.
 */
export function CreditsCard({ balance, onAddCredits }: CreditsCardProps) {
  const { t } = useTranslation("chat");
  if (balance === null) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-[var(--surface-base)] py-2 pl-2.5 pr-1.5 w-full">
      <div className="flex items-center gap-2">
        <Coins
          className="h-3.5 w-3.5 text-[color:var(--credits-accent)]"
          aria-hidden
        />
        <span
          className="text-body-medium-default font-normal! max-md:text-title-medium text-[color:var(--content-default)]"
          aria-label={t("creditsCard.balanceAria", { balance })}
        >
          {t("creditsCard.balanceShort", { balance })}
        </span>
      </div>
      {onAddCredits ? (
        <Button
          variant="ghost"
          size="regular"
          onClick={onAddCredits}
          className="h-6 gap-1 px-1.5 font-normal!"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("creditsCard.credits")}
        </Button>
      ) : null}
    </div>
  );
}
