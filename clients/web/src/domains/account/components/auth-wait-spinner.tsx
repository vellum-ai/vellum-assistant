import { Loader2 } from "lucide-react";

import { useTranslation } from "@/i18n";

/**
 * Held by `/account/login` and `/account/signup` while the session behind the
 * short-circuit decision settles, so the branded shell is never empty.
 */
export function AuthWaitSpinner() {
  const { t } = useTranslation("account");
  return (
    <Loader2
      className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
      aria-label={t("authWaitSpinner.loading")}
    />
  );
}
