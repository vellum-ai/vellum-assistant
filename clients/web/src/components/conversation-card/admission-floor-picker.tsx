/**
 * `AdmissionFloorPicker` — per-conversation admission-floor override picker
 * for group-chat conversations (§8.3). Sits inside the conversation card.
 *
 * Behavior:
 *
 * - Default selection is the channel-type floor (no override set).
 * - An "Inherit channel default" option lets the user clear the override.
 * - If the user picks a value that admits MORE senders than the type
 *   floor, an inline warning surfaces — copy mirrors the macOS picker and
 *   the CLI's `conversation-set` warning so the message is consistent
 *   across surfaces.
 */

import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import {
  ADMISSION_POLICY_VALUES,
  POLICY_LABELS,
  isLessRestrictiveThanTypeFloor,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

const INHERIT_VALUE = "__inherit__" as const;

type PickerValue = AdmissionPolicy | typeof INHERIT_VALUE;

export interface AdmissionFloorPickerProps {
  /** Current persisted override; `null` means "inherit type floor". */
  readonly override: AdmissionPolicy | null;
  /** Channel-type floor — used for the inherit option label + warning copy. */
  readonly typeFloor: AdmissionPolicy;
  /** Channel-type label cited in the warning copy ("Slack default is …"). */
  readonly channelLabel: string;
  /**
   * Invoked with the new override; `null` clears it back to the type
   * floor. Parent is responsible for persisting via
   * `setConversationOverride`.
   */
  readonly onChange: (next: AdmissionPolicy | null) => void;
  readonly disabled?: boolean;
}

export function AdmissionFloorPicker({
  override,
  typeFloor,
  channelLabel,
  onChange,
  disabled = false,
}: AdmissionFloorPickerProps) {
  const value: PickerValue = override ?? INHERIT_VALUE;

  const options = useMemo(
    () => [
      {
        value: INHERIT_VALUE as PickerValue,
        label: `Inherit channel default (${POLICY_LABELS[typeFloor]})`,
      },
      ...ADMISSION_POLICY_VALUES.map((p) => ({
        value: p as PickerValue,
        label: POLICY_LABELS[p],
      })),
    ],
    [typeFloor],
  );

  const showWarning =
    override !== null && isLessRestrictiveThanTypeFloor(override, typeFloor);

  return (
    <div className="space-y-2" data-testid="admission-floor-picker">
      <Dropdown<PickerValue>
        value={value}
        options={options}
        disabled={disabled}
        onChange={(next) =>
          onChange(next === INHERIT_VALUE ? null : (next as AdmissionPolicy))
        }
        aria-label="Per-conversation trust floor"
        data-testid="admission-floor-picker-dropdown"
      />
      {showWarning && (
        <div
          role="alert"
          data-testid="admission-floor-picker-warning"
          className="flex items-start gap-2 rounded-md border border-[var(--border-warning)] bg-[var(--surface-warning-subtle)] px-3 py-2 text-body-small-default text-[var(--content-warning)]"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {channelLabel} default is{" "}
            <strong>{POLICY_LABELS[typeFloor]}</strong>; choosing{" "}
            <strong>{POLICY_LABELS[override!]}</strong> for this conversation
            will admit more senders.
          </span>
        </div>
      )}
    </div>
  );
}
