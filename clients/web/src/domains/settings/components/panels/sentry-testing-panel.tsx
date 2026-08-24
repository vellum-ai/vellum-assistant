import * as Sentry from "@sentry/react";
import { AlertTriangle, Bug, Flame, Info, Timer, XCircle } from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

export function SentryTestingPanel() {
  const { t } = useTranslation("settings");

  const handleCaptureError = useCallback(() => {
    Sentry.captureException(new Error("[Dev Settings] Test error event"));
    toast.success(t("sentryTestingPanel.errorSentToast"));
  }, [t]);

  const handleCaptureWarning = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test warning event", "warning");
    toast.success(t("sentryTestingPanel.warningSentToast"));
  }, [t]);

  const handleCaptureInfo = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test info event", "info");
    toast.success(t("sentryTestingPanel.infoSentToast"));
  }, [t]);

  const handleCaptureFatal = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test fatal event", "fatal");
    toast.success(t("sentryTestingPanel.fatalSentToast"));
  }, [t]);

  const handleCaptureTransaction = useCallback(() => {
    const transaction = Sentry.startInactiveSpan({
      name: "[Dev Settings] Test transaction",
      op: "test.transaction",
      forceTransaction: true,
    });
    transaction.end();
    toast.success(t("sentryTestingPanel.transactionSentToast"));
  }, [t]);

  return (
    <DetailCard
      title={t("sentryTestingPanel.title")}
      subtitle={t("sentryTestingPanel.subtitle")}
    >
      <div className="space-y-3">
        <SentryTestRow
          icon={
            <Flame className="h-4 w-4 text-[var(--system-negative-strong)]" />
          }
          label={t("sentryTestingPanel.fatalLabel")}
          description={t("sentryTestingPanel.fatalDescription")}
          onClick={handleCaptureFatal}
        />
        <SentryTestRow
          icon={
            <XCircle className="h-4 w-4 text-[var(--system-negative-default)]" />
          }
          label={t("sentryTestingPanel.errorLabel")}
          description={t("sentryTestingPanel.errorDescription")}
          onClick={handleCaptureError}
        />
        <SentryTestRow
          icon={
            <AlertTriangle className="h-4 w-4 text-[var(--system-warning-default)]" />
          }
          label={t("sentryTestingPanel.warningLabel")}
          description={t("sentryTestingPanel.warningDescription")}
          onClick={handleCaptureWarning}
        />
        <SentryTestRow
          icon={<Info className="h-4 w-4 text-[var(--content-tertiary)]" />}
          label={t("sentryTestingPanel.infoLabel")}
          description={t("sentryTestingPanel.infoDescription")}
          onClick={handleCaptureInfo}
        />
        <SentryTestRow
          icon={
            <Timer className="h-4 w-4 text-[var(--system-positive-default)]" />
          }
          label={t("sentryTestingPanel.performanceLabel")}
          description={t("sentryTestingPanel.performanceDescription")}
          onClick={handleCaptureTransaction}
        />
      </div>
    </DetailCard>
  );
}

interface SentryTestRowProps {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}

function SentryTestRow({
  icon,
  label,
  description,
  onClick,
}: SentryTestRowProps) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-base)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0">
          <p className="text-body-medium-default text-[var(--content-default)]">
            {label}
          </p>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {description}
          </p>
        </div>
      </div>
      <Button variant="outlined" size="compact" onClick={onClick}>
        <Bug className="h-4 w-4" />
        {t("sentryTestingPanel.send")}
      </Button>
    </div>
  );
}
