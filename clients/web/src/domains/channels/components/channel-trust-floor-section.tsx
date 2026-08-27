import { useState } from "react";

import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Select } from "@vellumai/design-library/components/select";

import { useTranslation } from "@/i18n";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";

/**
 * Catalog keys for each floor's copy: its dropdown label, its description, and
 * (for floors that loosen or hard-deny who can reach the assistant) the
 * confirmation prompted before `onChange` fires. `confirm: undefined` is a
 * floor's explicit statement that it applies immediately, so every policy
 * declares which side of the gate it is on. The gate lives on this control
 * rather than its callers so every surface that renders a floor dropdown
 * confirms the same way: a page-level interceptor is a wiring step each new
 * caller can forget. Web-only UI concern; the cross-surface contract lives in
 * `@/lib/channel-admission-policy/types`.
 */
const POLICY_COPY = {
  no_one: {
    labelKey: "channelTrustFloor.noOne.label",
    descriptionKey: "channelTrustFloor.noOne.description",
    confirm: {
      titleKey: "channelTrustFloor.noOne.confirmTitle",
      messageKey: "channelTrustFloor.noOne.confirmMessage",
      actionKey: "channelTrustFloor.noOne.confirmAction",
      destructive: true,
    },
  },
  guardian_only: {
    labelKey: "channelTrustFloor.guardianOnly.label",
    descriptionKey: "channelTrustFloor.guardianOnly.description",
    confirm: undefined,
  },
  trusted_contacts: {
    labelKey: "channelTrustFloor.trustedContacts.label",
    descriptionKey: "channelTrustFloor.trustedContacts.description",
    confirm: undefined,
  },
  any_contact: {
    labelKey: "channelTrustFloor.anyContact.label",
    descriptionKey: "channelTrustFloor.anyContact.description",
    confirm: {
      titleKey: "channelTrustFloor.anyContact.confirmTitle",
      messageKey: "channelTrustFloor.anyContact.confirmMessage",
      actionKey: "channelTrustFloor.anyContact.confirmAction",
      destructive: false,
    },
  },
  strangers: {
    labelKey: "channelTrustFloor.strangers.label",
    descriptionKey: "channelTrustFloor.strangers.description",
    confirm: {
      titleKey: "channelTrustFloor.strangers.confirmTitle",
      messageKey: "channelTrustFloor.strangers.confirmMessage",
      actionKey: "channelTrustFloor.strangers.confirmAction",
      destructive: true,
    },
  },
} as const;

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
 * floor. Floors carrying a `confirm` entry in {@link POLICY_COPY} prompt a
 * ConfirmDialog before `onChange` fires; every other floor applies
 * immediately. Renders loading/error states rather than a concrete floor until
 * the GET resolves, so it never misreports (and lets the user overwrite) a
 * stored non-default policy.
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
  const options = ADMISSION_POLICY_VALUES.map((floor) => ({
    value: floor,
    label: t(POLICY_COPY[floor].labelKey),
    tooltip: t(POLICY_COPY[floor].descriptionKey, {
      assistant: assistantDisplayName,
    }),
  }));

  // Non-null while a floor with a `confirm` entry awaits the user's
  // go-ahead before persisting. The Select stays on the stored floor
  // meanwhile, so a cancel discards the pick with nothing to undo.
  const [pendingPolicy, setPendingPolicy] = useState<AdmissionPolicy | null>(
    null,
  );
  const pendingConfirmation = pendingPolicy
    ? POLICY_COPY[pendingPolicy].confirm
    : undefined;

  const handleChange = (next: AdmissionPolicy) => {
    if (POLICY_COPY[next].confirm) {
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
            {t(POLICY_COPY[value].descriptionKey, {
              assistant: assistantDisplayName,
            })}
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
        title={pendingConfirmation ? t(pendingConfirmation.titleKey) : ""}
        message={pendingConfirmation ? t(pendingConfirmation.messageKey) : ""}
        confirmLabel={
          pendingConfirmation
            ? t(pendingConfirmation.actionKey)
            : t("channelTrustFloor.confirmFallback")
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
