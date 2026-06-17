import { useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { SystemPermissionsCard } from "@/components/system-permissions-card";
import { AccessConsentSetting } from "@/domains/settings/components/access-consent-setting";
import { BiometricSettingsCard } from "@/domains/settings/components/biometric-settings-card";
import { RiskToleranceSettings } from "@/domains/settings/components/risk-tolerance-settings";
import { TrustRules } from "@/domains/settings/components/trust-rules/trust-rules";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useHasPlatformSession } from "@/stores/auth-store";
import {
    getDeviceBool,
    getDeviceSetting,
    setDeviceSetting,
} from "@/utils/device-settings";
import { savePreferenceToggle } from "@/utils/onboarding-cleanup";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Toggle } from "@vellumai/design-library/components/toggle";

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

function SettingRow({
  label,
  helperText,
  checked,
  onChange,
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="text-body-medium-default text-[var(--content-default)]">
          {label}
        </div>
        <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          {helperText}
        </p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

export function PrivacyPage() {
  // platformHostedOnly so the divider visibility matches the gate inside
  // `AccessConsentSetting` exactly.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const hasPlatformSession = useHasPlatformSession();
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
    savePreferenceToggle("share_analytics", next, hasPlatformSession);
  };

  const handleDiagnosticsToggle = () => {
    const next = !shareDiagnostics;
    setShareDiagnostics(next);
    savePreferenceToggle("share_diagnostics", next, hasPlatformSession);
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
      <DetailCard title="Privacy">
        <div className="space-y-4">
          <SettingRow
            label="Share Analytics"
            helperText="Send anonymous product usage data. Your conversations and personal data are never included."
            checked={shareAnalytics}
            onChange={handleAnalyticsToggle}
          />
          <Divider />
          <SettingRow
            label="Share Diagnostics"
            helperText="Send crash reports and performance metrics. Your conversations and personal data are never included."
            checked={shareDiagnostics}
            onChange={handleDiagnosticsToggle}
          />
          <Divider />
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
