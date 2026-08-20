import {
  CUSTOM_SENTINEL,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import { CallSiteOverrideRow } from "@/domains/settings/ai/call-site-overrides-row";
import { useTranslation } from "@/i18n";
import type { CallSiteDraftMap } from "@/domains/settings/ai/use-override-drafts";
import type {
  CallSiteOverrideDraft,
  ConfigLlmCallsitesGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallSiteCatalog = ConfigLlmCallsitesGetResponse;
type CallSiteEntry = CallSiteCatalog["callSites"][number];
type CallSiteDomain = CallSiteCatalog["domains"][number];

interface ProfileOption {
  value: string;
  label: string;
}

/** The call sites of one catalog domain, rendered under a single label. */
export interface CallSiteGroup {
  domain: CallSiteDomain;
  sites: CallSiteEntry[];
}

export interface OverridesCallSiteListProps {
  groups: CallSiteGroup[];
  drafts: CallSiteDraftMap;
  buildProfileOptionsForRow: (
    selectedProfile: string | null,
    includeCustom: boolean,
  ) => ProfileOption[];
  profileLabelFor: (name: string) => string;
  /**
   * Provider of a named profile from the loaded config, or undefined when
   * the profile (or its provider) is unknown. Scopes each row's custom
   * model picker to its winning route.
   */
  providerForProfile: (name: string) => string | undefined;
  /**
   * Whether a named profile is a mix. A mix winner has no single provider
   * kind, so its rows do not offer new Custom pins.
   */
  isMixProfile: (name: string) => boolean;
  advisorMatchesSearch: boolean;
  /** Passed through to each row's model picker; see CallSiteOverrideRowProps. */
  connections?: ProviderConnection[];
  onDraftChange: (id: string, draft: CallSiteOverrideDraft | null) => void;
  onToggle: (id: string, on: boolean) => void;
}

// ---------------------------------------------------------------------------
// OverridesCallSiteList
// ---------------------------------------------------------------------------

/**
 * The Action Overrides body: one `CallSiteOverrideRow` per call site, grouped
 * under its domain label, or the empty state when the search matches nothing.
 */
export function OverridesCallSiteList({
  groups,
  drafts,
  buildProfileOptionsForRow,
  profileLabelFor,
  providerForProfile,
  isMixProfile,
  advisorMatchesSearch,
  connections,
  onDraftChange,
  onToggle,
}: OverridesCallSiteListProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-4">
      {groups.length === 0 ? (
        // Suppressed when the Advisor row above already answered the
        // search: "no matches" next to a visible match reads as a bug.
        advisorMatchesSearch ? null : (
          <p className="py-8 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("overridesCallSiteList.emptySearch")}
          </p>
        )
      ) : (
        groups.map(({ domain, sites }) => (
          <div key={domain.id}>
            {/* typography: off-scale. Domain section label uses semibold+tracking for visual grouping */}
            <p className="mb-2 text-body-small-default font-semibold uppercase tracking-wider text-[var(--content-tertiary)]">
              {domain.displayName}
            </p>
            <div className="space-y-1">
              {sites.map((cs) => {
                const profileVal = (() => {
                  const d = drafts[cs.id] ?? null;
                  if (!d || !isDraftActive(d)) {
                    return "";
                  }
                  if (d.model || d.provider != null) {
                    return CUSTOM_SENTINEL;
                  }
                  return d.profile ?? "";
                })();
                // The caption names the shipped tier (what the action
                // falls back to when unpinned) when the daemon reports
                // one; `defaultProfile` is the effective winner, pins
                // included, so alone it would echo a pin back.
                const defaultKey =
                  cs.shippedDefaultProfile ?? cs.defaultProfile;
                const defaultProfileLabel = defaultKey
                  ? profileLabelFor(defaultKey)
                  : null;
                // A custom pin dispatches on the winning profile's route (a
                // model pin references no profile, so `defaultProfile` names
                // the chain's winner even under one). Undefined when neither
                // catalog field resolves to a known provider; the row then
                // offers the full model union and the daemon validates.
                const winnerName =
                  cs.defaultProfile ?? cs.shippedDefaultProfile;
                const winnerIsMix =
                  winnerName != null && isMixProfile(winnerName);
                const winningProvider =
                  winnerName != null && !winnerIsMix
                    ? providerForProfile(winnerName)
                    : undefined;
                // A mix winner offers no NEW Custom pins (which arm serves
                // a conversation is seeded per conversation, so no single
                // model list is honest). An existing custom pin stays
                // representable: hiding its option would blank the trigger
                // while the pin is still saved.
                const includeCustom =
                  !winnerIsMix || profileVal === CUSTOM_SENTINEL;

                return (
                  <CallSiteOverrideRow
                    key={cs.id}
                    id={cs.id}
                    displayName={cs.displayName}
                    description={cs.description}
                    defaultProfileLabel={defaultProfileLabel}
                    draft={drafts[cs.id] ?? null}
                    profileOptions={buildProfileOptionsForRow(
                      profileVal === "" || profileVal === CUSTOM_SENTINEL
                        ? null
                        : profileVal,
                      includeCustom,
                    )}
                    winningProvider={winningProvider}
                    connections={connections}
                    onDraftChange={onDraftChange}
                    onToggle={onToggle}
                  />
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
