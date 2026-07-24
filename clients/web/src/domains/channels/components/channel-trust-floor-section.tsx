import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  getPolicyDescriptions,
  POLICY_LABELS,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";

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
 * Telegram/Phone panel: a dropdown of floors, the active floor's description,
 * and an info notice for the verified-contacts floor. Renders loading/error
 * states rather than a concrete floor until the GET resolves, so it never
 * misreports (and lets the user overwrite) a stored non-default policy.
 */
export function ChannelTrustFloorSection({
  assistantDisplayName,
  policy,
  saving = false,
  loading = false,
  error = false,
  onChange,
}: ChannelTrustFloorSectionProps) {
  const value = policy ?? ADMISSION_POLICY_DEFAULT;
  const descriptions = getPolicyDescriptions(assistantDisplayName);
  const options = ADMISSION_POLICY_VALUES.map((floor) => ({
    value: floor,
    label: POLICY_LABELS[floor],
    tooltip: descriptions[floor],
  }));

  return (
    <div className="flex flex-col gap-2">
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[color:var(--content-secondary)]"
      >
        Who can message {assistantDisplayName}
      </Typography>
      {loading ? (
        // Hold off on rendering a concrete floor until the GET succeeds — the
        // default would otherwise misreport a channel with a stored non-default
        // (e.g. `no_one`) policy and let the user overwrite it.
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[color:var(--content-tertiary)]"
        >
          Loading…
        </Typography>
      ) : error ? (
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[color:var(--content-negative)]"
        >
          Couldn’t load this setting. Try reopening this page.
        </Typography>
      ) : (
        <>
          <div style={{ maxWidth: 280 }}>
            <Dropdown<AdmissionPolicy>
              value={value}
              onChange={onChange}
              options={options}
              disabled={saving}
              aria-label={`Who can message ${assistantDisplayName}`}
            />
          </div>
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            {descriptions[value]}
          </Typography>
          {value === "trusted_contacts" ? (
            <Notice tone="info" className="max-w-lg">
              People you haven’t verified yet — even teammates in the same
              channel — can’t get through: {assistantDisplayName} lets them know
              they need to be verified and notifies you. You can verify people
              ahead of time in Contacts.
            </Notice>
          ) : null}
        </>
      )}
    </div>
  );
}
