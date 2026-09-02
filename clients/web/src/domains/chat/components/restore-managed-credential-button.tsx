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

import { useTranslation } from "@/i18n";
import { recoverLocalAssistantPlatformCredential } from "@/lib/local-platform-identity";
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

export function RestoreManagedCredentialButton({
  onRestored,
}: RestoreManagedCredentialButtonProps) {
  const { t } = useTranslation("chat");
  const [isRestoring, setIsRestoring] = useState(false);

  const restore = async () => {
    setIsRestoring(true);
    try {
      await recoverLocalAssistantPlatformCredential();
      toast.success(t("chatRouteContent.restoreCredentialSuccess"));
      onRestored?.();
    } catch (err) {
      // The reason is the useful half: "sign in to Vellum" and "this client
      // cannot repair this assistant" need different things from the reader,
      // so the thrown message is shown rather than a generic failure.
      captureError(err, { context: "restoreManagedCredential" });
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <Button
      variant="outlined"
      size="compact"
      disabled={isRestoring}
      onClick={() => void restore()}
    >
      {isRestoring
        ? t("chatRouteContent.restoringCredential")
        : t("chatRouteContent.restoreCredential")}
    </Button>
  );
}
