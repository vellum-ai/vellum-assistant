import { useState } from "react";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Select } from "@vellumai/design-library/components/select";

import { useTranslation } from "@/i18n";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  getPolicyDescriptions,
  POLICY_LABELS,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";

/**
 * Floors that loosen or hard-deny who can reach the assistant and warrant an
 * explicit confirmation before persisting. Floors not listed here apply
 * immediately. Lives on the control rather than its callers so every surface
 * that renders a floor dropdown confirms the same way: a page-level
 * interceptor is a wiring step each new caller can forget. Web-only UI
 * concern; the cross-surface contract lives in
 * `@/lib/channel-admission-policy/types`.
 *
 * Deliberately uncatalogued copy, matching `POLICY_LABELS` and
 * `getPolicyDescriptions` beside the contract: the admission-policy copy
 * should convert to i18n as one piece.
 */
const POLICY_CONFIRMATIONS: Partial<
  Record<
    AdmissionPolicy,
    {
      title: string;
      message: string;
      confirmLabel: string;
      destructive?: boolean;
    }
  >
> = {
  no_one: {
    title: "Block all messages?",
    message:
      "Setting this channel to “No one” hard-denies every inbound message, including messages from you.\n\nYou can reverse this at any time.",
    confirmLabel: "Block all",
    destructive: true,
  },
  any_contact: {
    title: "Allow any contact?",
    message:
      "“Any contact” admits every matched contact in this channel (including pending, unverified ones), not just your verified contacts.\n\nBest for channels consisting of only people you already trust.",
    confirmLabel: "Allow any contact",
  },
  strangers: {
    title: "Allow strangers?",
    message:
      "Are you sure you want to allow strangers to contact your assistant through this channel?\n\nDoing so could cost you money and open you up to security and privacy vulnerabilities.\n\nEnable with extreme caution.",
    confirmLabel: "Allow strangers",
    destructive: true,
  },
};

interface ChannelTrustFloorSectionProps {
  assistantDisplayName: string;
  policy?: AdmissionPolicy;
  saving?: boolean;
  loading?: boolean;
  error?: boolean;
  onChange: (policy: AdmissionPolicy) => void;
}

/**
 * The "Who can message {assistant}" admission-floor control on a connected
 * Telegram/Phone panel and on the plugin channel panel: a dropdown of floors,
 * the active floor's description, and an info notice for the verified-contacts
 * floor. Floors in {@link POLICY_CONFIRMATIONS} prompt a ConfirmDialog before
 * `onChange` fires; every other floor applies immediately. Renders
 * loading/error states rather than a concrete floor until the GET resolves, so
 * it never misreports (and lets the user overwrite) a stored non-default
 * policy.
 */
export function ChannelTrustFloorSection({
  assistantDisplayName,
  policy,
  saving = false,
  loading = false,
  error = false,
  onChange,
}: ChannelTrustFloorSectionProps) {
  const { t } = useTranslation("channels");
  const value = policy ?? ADMISSION_POLICY_DEFAULT;
  const descriptions = getPolicyDescriptions(assistantDisplayName);
  const options = ADMISSION_POLICY_VALUES.map((floor) => ({
    value: floor,
    label: POLICY_LABELS[floor],
    tooltip: descriptions[floor],
  }));

  // Non-null while a floor in POLICY_CONFIRMATIONS awaits the user's
  // go-ahead before persisting. The Select stays on the stored floor
  // meanwhile, so a cancel discards the pick with nothing to undo.
  const [pendingPolicy, setPendingPolicy] = useState<AdmissionPolicy | null>(
    null,
  );
  const pendingConfirmation = pendingPolicy
    ? POLICY_CONFIRMATIONS[pendingPolicy]
    : null;

  const handleChange = (next: AdmissionPolicy) => {
    if (POLICY_CONFIRMATIONS[next]) {
      setPendingPolicy(next);
      return;
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[color:var(--content-secondary)]"
      >
        {t("channelTrustFloor.heading", { assistant: assistantDisplayName })}
      </Typography>
      {loading ? (
        // Hold off on rendering a concrete floor until the GET succeeds — the
        // default would otherwise misreport a channel with a stored non-default
        // (e.g. `no_one`) policy and let the user overwrite it.
        <Typography
          as="span"
          variant="body-small-lighter"
          className="text-[color:var(--content-tertiary)]"
        >
          {t("channelTrustFloor.loading")}
        </Typography>
      ) : error ? (
        <Typography
          as="span"
          variant="body-small-lighter"
          className="text-[color:var(--content-negative)]"
        >
          {t("channelTrustFloor.loadFailed")}
        </Typography>
      ) : (
        <>
          <div style={{ maxWidth: 280 }}>
            <Select<AdmissionPolicy>
              value={value}
              onChange={handleChange}
              options={options}
              disabled={saving}
              aria-label={t("channelTrustFloor.selectAria", {
                assistant: assistantDisplayName,
              })}
            />
          </div>
          <Typography
            as="span"
            variant="body-small-lighter"
            className="text-[color:var(--content-tertiary)]"
          >
            {descriptions[value]}
          </Typography>
          {value === "trusted_contacts" ? (
            <Notice tone="info" className="max-w-lg">
              {t("channelTrustFloor.trustedContactsNotice", {
                assistant: assistantDisplayName,
              })}
            </Notice>
          ) : null}
        </>
      )}

      {/* Loosening or hard-denying access needs a nod before it persists. */}
      <ConfirmDialog
        open={pendingPolicy !== null}
        title={pendingConfirmation?.title ?? ""}
        message={pendingConfirmation?.message ?? ""}
        confirmLabel={
          pendingConfirmation?.confirmLabel ??
          t("channelTrustFloor.confirmFallback")
        }
        destructive={pendingConfirmation?.destructive ?? false}
        onConfirm={() => {
          if (pendingPolicy) {
            onChange(pendingPolicy);
          }
          setPendingPolicy(null);
        }}
        onCancel={() => setPendingPolicy(null)}
      />
    </div>
  );
}
