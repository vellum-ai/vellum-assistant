import { Plus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { LanguageModelSection } from "@/domains/settings/ai/language-model-section";
import { BlockedDeleteModal } from "@/domains/settings/ai/manage-profiles-blocked-delete-modal";
import { ProfileRow } from "@/domains/settings/ai/profile-row";
import { useInferenceProfileList } from "@/domains/settings/ai/use-inference-profiles";
import { useProfileActions } from "@/domains/settings/ai/use-profile-actions";
import { useProfileDeleteFlow } from "@/domains/settings/ai/use-profile-delete-flow";
import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

interface ProfilesSectionProps {
  assistantId: string;
  config: ConfigGetResponse | undefined;
  /** Connection rows, for openai-compatible model display names. */
  connections?: ProviderConnection[];
  /** Name of the profile currently open in the sidepanel, if any. */
  selectedProfileName: string | null;
  onOpenProfile: (name: string) => void;
  onCreateProfile: () => void;
  /**
   * Deleting the profile that's open in the sidepanel must also close the
   * panel; the page passes the close-through here.
   */
  onProfileDeleted: (name: string) => void;
}

/**
 * The inline Profiles list of the V2 Language Model card (Figma
 * 7412:133358). Rows open the profile sidepanel; the kebab menu carries
 * Make Default / Enable / Disable / Delete.
 */
export function ProfilesSection({
  assistantId,
  config,
  connections,
  selectedProfileName,
  onOpenProfile,
  onCreateProfile,
  onProfileDeleted,
}: ProfilesSectionProps) {
  const { entries } = useInferenceProfileList(assistantId, config);
  const actions = useProfileActions(assistantId);
  const deleteFlow = useProfileDeleteFlow(assistantId, config, {
    onDeleted: onProfileDeleted,
  });

  const activeProfile = config?.llm?.activeProfile ?? null;

  return (
    <>
      <LanguageModelSection
        title="Profiles"
        action={
          <Button
            variant="primary"
            size="compact"
            onClick={onCreateProfile}
            leftIcon={<Plus />}
            // The create panel needs config for duplicate-key validation
            // and the profileOrder append - hold the door until it exists.
            disabled={config == null}
          >
            Create Profile
          </Button>
        }
      >
        {config == null ? (
          // The row actions (open, delete, make default) read config state
          // - active/advisor selections, call-site references, profileOrder.
          // The effective-catalog query can win the race against configGet
          // on a cold load, so hold the rows back until config exists
          // rather than exposing actions that would see blank state.
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-4 text-center text-(--content-tertiary)"
          >
            Loading profiles…
          </Typography>
        ) : entries.length === 0 ? (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-4 text-center text-(--content-tertiary)"
          >
            No profiles yet. Create one to get started.
          </Typography>
        ) : (
          entries.map((profile) => (
            <ProfileRow
              key={profile.name}
              profile={profile}
              isActiveProfile={profile.name === activeProfile}
              selected={profile.name === selectedProfileName}
              connections={connections}
              onOpen={() => onOpenProfile(profile.name)}
              onMakeActive={() => void actions.makeActive(profile.name)}
              onSetStatus={(active) =>
                void actions.setStatus(profile.name, active)
              }
              onDelete={() => deleteFlow.requestDelete(profile.name)}
            />
          ))
        )}
      </LanguageModelSection>

      <BlockedDeleteModal {...deleteFlow.blockedDeleteModalProps} />
    </>
  );
}
