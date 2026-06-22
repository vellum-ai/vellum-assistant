import * as Sentry from "@sentry/react";
import {
    AlertTriangle,
    Bug,
    Flame,
    Info,
    Timer,
    XCircle,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";

import { DetailCard } from "@/components/detail-card";
import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

export function SentryTestingPanel() {
  const handleCaptureError = useCallback(() => {
    Sentry.captureException(new Error("[Dev Settings] Test error event"));
    toast.success("Sentry error event sent.");
  }, []);

  const handleCaptureWarning = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test warning event", "warning");
    toast.success("Sentry warning event sent.");
  }, []);

  const handleCaptureInfo = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test info event", "info");
    toast.success("Sentry info event sent.");
  }, []);

  const handleCaptureFatal = useCallback(() => {
    Sentry.captureMessage("[Dev Settings] Test fatal event", "fatal");
    toast.success("Sentry fatal event sent.");
  }, []);

  const handleCaptureTransaction = useCallback(() => {
    const transaction = Sentry.startInactiveSpan({
      name: "[Dev Settings] Test transaction",
      op: "test.transaction",
      forceTransaction: true,
    });
    transaction.end();
    toast.success("Sentry performance transaction sent.");
  }, []);

  return (
    <DetailCard
      title="Sentry Testing"
      subtitle="Fire test events to verify Sentry integration is working."
    >
      <div className="space-y-3">
        <SentryTestRow
          icon={
            <Flame className="h-4 w-4 text-[var(--system-negative-strong)]" />
          }
          label="Fatal Event"
          description="Send a fatal-level event to Sentry."
          onClick={handleCaptureFatal}
        />
        <SentryTestRow
          icon={
            <XCircle className="h-4 w-4 text-[var(--system-negative-default)]" />
          }
          label="Error Event"
          description="Capture a test Error exception."
          onClick={handleCaptureError}
        />
        <SentryTestRow
          icon={
            <AlertTriangle className="h-4 w-4 text-[var(--system-warning-default)]" />
          }
          label="Warning Event"
          description="Send a warning-level message."
          onClick={handleCaptureWarning}
        />
        <SentryTestRow
          icon={
            <Info className="h-4 w-4 text-[var(--content-tertiary)]" />
          }
          label="Info Event"
          description="Send an info-level message."
          onClick={handleCaptureInfo}
        />
        <SentryTestRow
          icon={
            <Timer className="h-4 w-4 text-[var(--system-positive-default)]" />
          }
          label="Performance Transaction"
          description="Start and end a test transaction span."
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
        Send
      </Button>
    </div>
  );
}
