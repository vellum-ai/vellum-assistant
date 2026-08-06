import { Select } from "@vellumai/design-library/components/select";

interface ProfileOption {
  value: string;
  label: string;
}

export interface AdvisorProfileRowProps {
  /** Current `llm.advisorProfile` draft value; empty renders the placeholder. */
  value: string;
  profileOptions: ProfileOption[];
  disabled?: boolean;
  onChange: (profile: string) => void;
}

/**
 * The Advisor setting in the Action Overrides panel: which profile the
 * second-opinion consult runs on (`llm.advisorProfile`).
 *
 * Shaped like `CallSiteOverrideRow` but deliberately picker-only: no
 * toggle, no off state, no Custom provider/model branch:
 *
 * - `llm.advisorProfile` holds a profile name and nothing else, so there is
 *   nowhere to persist a bare provider + model pin.
 * - There is no durable off state to offer. `seedInferenceProfiles` runs on
 *   every daemon boot and re-fills the key whenever it is absent, so an
 *   "off" choice would silently revert on the next restart.
 *
 * The value therefore renders empty only in the window between deleting the
 * advisor's profile (which clears the reference so no dangling name
 * survives) and the next boot's reseed.
 */
export function AdvisorProfileRow({
  value,
  profileOptions,
  disabled,
  onChange,
}: AdvisorProfileRowProps) {
  return (
    <div className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* typography: off-scale. Matches the call-site row's name treatment */}
          <p className="text-body-medium-default font-medium text-[var(--content-default)]">
            Advisor
          </p>
          <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            The profile your assistant consults for a second opinion when it
            wants to check a plan or review its own work.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={value}
            onChange={onChange}
            options={profileOptions}
            placeholder="Choose profile…"
            className="w-44"
            menuMinWidth={280}
            menuAlign="end"
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
