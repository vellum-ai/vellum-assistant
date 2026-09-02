/**
 * The repair for a rejected Vellum-managed credential, offered on the chat
 * error banner.
 *
 * The assistant cannot mint this credential: the platform issues it and a
 * signed-in client writes it in. The platform leaves self-hosted and local
 * registrations to their client on purpose, so this button is that client
 * doing its half, and it is the only in-app way back from a rejected key.
 */
import { useState } from "react";

import { PlatformLoginButton } from "@/components/platform-login-button";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import {
  LocalPlatformCredentialRecoveryError,
  type LocalPlatformCredentialRecoveryReason,
  recoverLocalAssistantPlatformCredential,
} from "@/lib/local-platform-identity";
import { captureError } from "@/lib/sentry/capture-error";
import { Button } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

export interface RestoreManagedCredentialButtonProps {
  /**
   * Runs once the credential is confirmed working. The banner offering this
   * button describes a failure that no longer holds, so its owner retires
   * it here; a failed attempt leaves the banner in place to try again.
   */
  onRestored?: () => void;
}

/**
 * Catalog key for each typed repair failure. The reader gets a sentence in
 * their language that says what to do next; the thrown message stays in
 * error reporting.
 */
const FAILURE_KEYS: Record<
  LocalPlatformCredentialRecoveryReason,
  | "restoreManagedCredentialButton.failedNoAssistant"
  | "restoreManagedCredentialButton.failedCannotActHere"
  | "restoreManagedCredentialButton.failedReplacementRejected"
  | "restoreManagedCredentialButton.failedUnconfirmed"
> = {
  no_assistant: "restoreManagedCredentialButton.failedNoAssistant",
  cannot_act_here: "restoreManagedCredentialButton.failedCannotActHere",
  replacement_rejected:
    "restoreManagedCredentialButton.failedReplacementRejected",
  unconfirmed: "restoreManagedCredentialButton.failedUnconfirmed",
};

export function RestoreManagedCredentialButton({
  onRestored,
}: RestoreManagedCredentialButtonProps) {
  const { t } = useTranslation("chat");
  const platformGate = usePlatformGate();
  const [isRestoring, setIsRestoring] = useState(false);

  const restore = async () => {
    setIsRestoring(true);
    try {
      await recoverLocalAssistantPlatformCredential();
      toast.success(t("restoreManagedCredentialButton.restored"));
      onRestored?.();
    } catch (err) {
      captureError(err, { context: "restoreManagedCredential" });
      // Only a typed reason reaches the reader. Anything else (a platform or
      // transport failure with its own text) is reported generically, so raw
      // exception text never stands in for translated copy.
      toast.error(
        t(
          err instanceof LocalPlatformCredentialRecoveryError
            ? FAILURE_KEYS[err.reason]
            : "restoreManagedCredentialButton.failedGeneric",
        ),
      );
    } finally {
      setIsRestoring(false);
    }
  };

  // The repair rotates the credential through the platform, which needs a
  // platform session. Without one it would fail after the press, so the slot
  // asks for the sign-in first, the documented "disabled" treatment. The
  // surface offering this button already excludes the platform-disabled
  // configuration, so "gated" is unreachable here and renders nothing rather
  // than a repair that cannot run.
  if (platformGate === "gated") {
    return null;
  }
  if (platformGate === "disabled") {
    return <PlatformLoginButton variant="outlined" size="compact" />;
  }

  return (
    <Button
      variant="outlined"
      size="compact"
      disabled={isRestoring}
      onClick={() => void restore()}
    >
      {isRestoring
        ? t("restoreManagedCredentialButton.restoring")
        : t("restoreManagedCredentialButton.restore")}
    </Button>
  );
}
