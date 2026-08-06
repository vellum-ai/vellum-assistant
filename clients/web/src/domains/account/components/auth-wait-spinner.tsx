import { Loader2 } from "lucide-react";

/**
 * Held by `/account/login` and `/account/signup` while the session behind the
 * short-circuit decision settles, so the branded shell is never empty.
 */
export function AuthWaitSpinner() {
  return (
    <Loader2
      className="h-6 w-6 animate-spin text-[var(--content-tertiary)]"
      aria-label="Loading"
    />
  );
}
