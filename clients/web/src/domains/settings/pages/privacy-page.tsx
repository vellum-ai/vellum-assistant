import { useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { SettingRow } from "@/components/setting-row";
import { SystemPermissionsCard } from "@/components/system-permissions-card";
import { AccessConsentSetting } from "@/domains/settings/components/access-consent-setting";
import { BiometricSettingsCard } from "@/domains/settings/components/biometric-settings-card";
import { MediaEmbedsCard } from "@/domains/settings/components/media-embeds-card";
import { RiskToleranceSettings } from "@/domains/settings/components/risk-tolerance-settings";
import { TrustRules } from "@/domains/settings/components/trust-rules/trust-rules";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import {
  useAuthStore,
  useHasConfirmedPlatformSession,
} from "@/stores/auth-store";
import {
    getDeviceBool,
    getDeviceSetting,
    setDeviceSetting,
} from "@/utils/device-settings";
import { savePreferenceToggle } from "@/utils/onboarding-cleanup";
import { legalUrl, routes } from "@/utils/routes";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "dontRetain", label: "Don't retain" },
  { value: "oneHour", label: "1 hour" },
  { value: "oneDay", label: "1 day" },
  { value: "sevenDays", label: "7 days" },
  { value: "thirtyDays", label: "30 days" },
  { value: "ninetyDays", label: "90 days" },
  { value: "keepForever", label: "Keep forever" },
];

const DEFAULT_RETENTION_ID = "thirtyDays";

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

export function PrivacyPage() {
  // platformHostedOnly so the divider visibility matches the gate inside
  // `AccessConsentSetting` exactly.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // The Share toggles control telemetry (browser Sentry, daemon analytics) that
  // only runs with a probe-confirmed live platform session, so gate both the
  // visibility and the consent write on it — matching `sentry-control.ts`. A
  // believed offline restore (LUM-2412) is not live, so the toggles hide and a
  // flip can't stamp version-currency offline.
  const hasPlatformSession = useHasConfirmedPlatformSession();
  const showShareConsent = hasPlatformSession;
  const userId = useAuthStore.use.user()?.id ?? null;
  const [shareAnalytics, setShareAnalytics] = useState(
    () => getDeviceBool("shareAnalytics", true),
  );
  const [shareDiagnostics, setShareDiagnostics] = useState(
    () => getDeviceBool("shareDiagnostics", true),
  );
  const [retentionId, setRetentionId] = useState(() =>
    getDeviceSetting("llmLogRetention", DEFAULT_RETENTION_ID),
  );

  const handleAnalyticsToggle = () => {
    const next = !shareAnalytics;
    setShareAnalytics(next);
    savePreferenceToggle("share_analytics", next, { userId, hasPlatformSession });
  };

  const handleDiagnosticsToggle = () => {
    const next = !shareDiagnostics;
    setShareDiagnostics(next);
    savePreferenceToggle("share_diagnostics", next, { userId, hasPlatformSession });
  };

  const handleRetentionChange = (value: string) => {
    setRetentionId(value);
    setDeviceSetting("llmLogRetention", value);
  };

  return (
    <div className="space-y-4">
      <BiometricSettingsCard />
      <SystemPermissionsCard />
      <TrustRules />
      <RiskToleranceSettings />
      <MediaEmbedsCard />
      <DetailCard
        title="Privacy"
        subtitle={
          hasPlatformSession ? (
            <>
              View details about what data we collect and how it's used in our{" "}
              <a
                href={legalUrl(routes.docs.legal.privacyPolicy)}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                privacy policy
              </a>
              .
            </>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {showShareConsent && (
            <>
              <SettingRow
                label="Share Analytics"
                helperText="Send aggregated product usage data"
                checked={shareAnalytics}
                onChange={handleAnalyticsToggle}
                variant="toggle-trailing"
              />
              <Divider />
              <SettingRow
                label="Share Diagnostics"
                helperText="Send crash reports, conversation traces, and session replay data"
                checked={shareDiagnostics}
                onChange={handleDiagnosticsToggle}
                variant="toggle-trailing"
              />
              <Divider />
            </>
          )}
          <AccessConsentSetting />
          {/*
            `AccessConsentSetting` returns null when gated (self-hosted
            assistants). Hide the trailing divider in that case so we
            don't render two adjacent dividers around a missing row.
          */}
          {platformGate !== "gated" && <Divider />}
          <div>
            <label
              htmlFor="llm-log-retention"
              className="block text-body-medium-default text-[var(--content-default)]"
            >
              LLM Request Log Retention
            </label>
            <div className="mt-2" style={{ maxWidth: 280 }}>
              <Dropdown
                value={retentionId}
                onChange={handleRetentionChange}
                options={RETENTION_OPTIONS}
              />
            </div>
            <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
              How long to keep LLM request and response logs on this device.
              These logs record the prompts and completions sent to model
              providers and are used for debugging. Shorter retention improves
              privacy; longer retention helps troubleshoot issues.
            </p>
          </div>
        </div>
      </DetailCard>
    </div>
  );
}
