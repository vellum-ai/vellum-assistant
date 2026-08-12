import { Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { EmailsTab } from "@/domains/logs/components/emails-tab";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";

import { useTranslation } from "@/i18n";

export function EmailsPage() {
  const { t } = useTranslation("logs");
  const platformGate = usePlatformGate();
  const assistantId = useActiveAssistantId();

  if (platformGate === "gated") {
    return <Navigate replace to={routes.logs.root} />;
  }

  if (platformGate === "disabled") {
    return (
      <PlatformLoginNotice>
        {t("emailsPage.platformLoginNotice")}
      </PlatformLoginNotice>
    );
  }

  return <EmailsTab assistantId={assistantId} platformGate={platformGate} />;
}
