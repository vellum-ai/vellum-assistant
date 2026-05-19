
import { useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Toggle } from "@vellum/design-library/components/toggle";
import { BiometricSettingsCard } from "@/components/app/settings/BiometricSettingsCard.js";
import { AccessConsentSetting } from "@/components/app/settings/AccessConsentSetting.js";
import { RiskToleranceSettings } from "@/components/app/settings/RiskToleranceSettings.js";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import { TrustRules } from "@/components/app/settings/TrustRules/index.js";

import { getLocalSetting, setLocalSetting } from "@/domains/settings/_lib/local-settings.js";

const LS_SHARE_ANALYTICS = "vellum_share_analytics";
const LS_SHARE_DIAGNOSTICS = "vellum_share_diagnostics";
const LS_LLM_LOG_RETENTION = "vellum_llm_log_retention";

const RETENTION_OPTIONS: { id: string; label: string }[] = [
  { id: "dontRetain", label: "Don't retain" },
  { id: "oneHour", label: "1 hour" },
  { id: "oneDay", label: "1 day" },
  { id: "sevenDays", label: "7 days" },
  { id: "thirtyDays", label: "30 days" },
  { id: "ninetyDays", label: "90 days" },
  { id: "keepForever", label: "Keep forever" },
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
      <Toggle
        checked={checked}
        onChange={() => onChange()}
        aria-label={label}
      />
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />;
}

export default function PrivacySettingsPage() {
  const [shareAnalytics, setShareAnalytics] = useState(
    () => getLocalSetting(LS_SHARE_ANALYTICS, "true") === "true",
  );
  const [shareDiagnostics, setShareDiagnostics] = useState(
    () => getLocalSetting(LS_SHARE_DIAGNOSTICS, "true") === "true",
  );
  const [retentionId, setRetentionId] = useState(() =>
    getLocalSetting(LS_LLM_LOG_RETENTION, DEFAULT_RETENTION_ID),
  );

  const handleAnalyticsToggle = () => {
    const next = !shareAnalytics;
    setShareAnalytics(next);
    setLocalSetting(LS_SHARE_ANALYTICS, String(next));
  };

  const handleDiagnosticsToggle = () => {
    const next = !shareDiagnostics;
    setShareDiagnostics(next);
    setLocalSetting(LS_SHARE_DIAGNOSTICS, String(next));
  };

  const handleRetentionChange = (value: string) => {
    setRetentionId(value);
    setLocalSetting(LS_LLM_LOG_RETENTION, value);
  };

  return (
    <div className="max-w-[940px] space-y-4">
      <BiometricSettingsCard />
      <TrustRules />
      <RiskToleranceSettings />
      <SettingsCard title="Privacy">
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
                id="llm-log-retention"
                value={retentionId}
                onChange={handleRetentionChange}
                options={RETENTION_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                aria-label="LLM Request Log Retention"
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
      </SettingsCard>
    </div>
  );
}
