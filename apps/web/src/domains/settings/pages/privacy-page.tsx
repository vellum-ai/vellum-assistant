import { useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Toggle } from "@vellum/design-library/components/toggle";
import { DetailCard } from "@/components/detail-card";
import { BiometricSettingsCard } from "@/domains/settings/components/biometric-settings-card";
import { AccessConsentSetting } from "@/domains/settings/components/access-consent-setting";
import { RiskToleranceSettings } from "@/domains/settings/components/risk-tolerance-settings";
import { TrustRules } from "@/domains/settings/components/trust-rules/trust-rules";
import {
  getDeviceBool,
  getDeviceSetting,
  setDeviceBool,
  setDeviceSetting,
} from "@/lib/device-settings";

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
    setDeviceBool("shareAnalytics", next);
  };

  const handleDiagnosticsToggle = () => {
    const next = !shareDiagnostics;
    setShareDiagnostics(next);
    setDeviceBool("shareDiagnostics", next);
  };

  const handleRetentionChange = (value: string) => {
    setRetentionId(value);
    setDeviceSetting("llmLogRetention", value);
  };

  return (
    <div className="max-w-[940px] space-y-4">
      <BiometricSettingsCard />
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
          <Divider />
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
