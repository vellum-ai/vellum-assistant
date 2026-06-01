import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, ConfirmDialog } from "@vellum/design-library";
import { ConstellationView } from "@/domains/intelligence/components/constellation-view/constellation-view";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { AvatarManagementModal } from "@/components/avatar/avatar-management-modal";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { deleteAvatar } from "@/assistant/avatar-api";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { fetchSkills, installSkill, uninstallSkill } from "@/domains/intelligence/skills/api";
import type { SkillInfo } from "@/domains/intelligence/skills/types";
import { getAssistant } from "@/assistant/api";
import { fetchAssistantIdentity } from "@/assistant/identity";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";

export interface IdentityCardProps {
  assistantName: string;
  assistantPersonality: string;
  assistantRole: string;
  hatchedDate: string;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  onOpenThread?: (message: string) => void;
  onOpenModal: () => void;
}

export function IdentityCard({
  assistantName,
  assistantPersonality,
  assistantRole,
  hatchedDate,
  components,
  traits,
  customImageUrl,
  onOpenThread,
  onOpenModal,
}: IdentityCardProps) {
  return (
    <div
      className="w-full overflow-hidden rounded-xl"
      style={{
        backgroundColor: "var(--surface-lift)",
      }}
    >
      <div className="relative p-6 pb-0">
        <div className="pr-8 text-center">
          <h2
            className="text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            {assistantName}
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          iconOnly={<Pencil aria-hidden />}
          onClick={() => onOpenThread?.("I would like to change your name")}
          disabled={!onOpenThread}
          aria-label="Edit identity"
          title="Edit Name"
          className="absolute right-6 top-6"
          tintColor="var(--content-tertiary)"
        />
      </div>

      <div className="flex justify-center py-6">
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={200}
          interactive
        />
      </div>

      <div className="flex justify-center pb-6">
        <Button
          type="button"
          variant="outlined"
          size="regular"
          onClick={onOpenModal}
          className="!rounded-full"
        >
          Update Avatar
        </Button>
      </div>

      <div
        className="border-t"
        style={{ borderColor: "var(--border-base)" }}
      />

      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--border-base)" }}
      >
        <div>
          <p className="text-body-small-default" style={{ color: "var(--content-tertiary)" }}>
            Role
          </p>
          <p
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {assistantRole}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          iconOnly={<Pencil aria-hidden />}
          onClick={() => onOpenThread?.("I would like to change your role description")}
          disabled={!onOpenThread}
          aria-label="Edit role"
          title="Edit Role"
          tintColor="var(--content-tertiary)"
        />
      </div>

      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--border-base)" }}
      >
        <div className="min-w-0 flex-1">
          <p className="text-body-small-default" style={{ color: "var(--content-tertiary)" }}>
            Personality
          </p>
          <p
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
            title={assistantPersonality || "Not set"}
          >
            {assistantPersonality || "Not set"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          iconOnly={<Pencil aria-hidden />}
          onClick={() => onOpenThread?.("I would like to change your personality")}
          disabled={!onOpenThread}
          aria-label="Edit personality"
          title="Edit Personality"
          tintColor="var(--content-tertiary)"
        />
      </div>

      <div className="px-4 py-3">
        <p className="text-body-small-default" style={{ color: "var(--content-tertiary)" }}>
          Hatched
        </p>
        <p
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {hatchedDate}
        </p>
      </div>
    </div>
  );
}

interface IdentityTabProps {
  assistantId: string;
  onOpenThread?: (message: string) => void;
}

export function IdentityTab({ assistantId, onOpenThread }: IdentityTabProps) {
  const queryClient = useQueryClient();
  const {
    components,
    traits,
    customImageUrl,
    isLoading: isAvatarLoading,
    invalidate: invalidateAvatar,
  } = useAssistantAvatar(assistantId);
  const [identity, setIdentity] = useState<IdentityGetResponse | null>(null);
  const [assistantCreatedAt, setAssistantCreatedAt] = useState<string | null>(null);
  const [loadedAssistantId, setLoadedAssistantId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] = useState<SkillInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchAssistantIdentity(assistantId),
      getAssistant(assistantId).catch(() => ({ ok: false as const, status: 0, error: {} })),
    ]).then(([identityData, assistantResult]) => {
      if (cancelled) return;
      setIdentity(identityData);
      if (assistantResult.ok) {
        setAssistantCreatedAt(assistantResult.data.created);
      } else {
        setAssistantCreatedAt(null);
      }
      setLoadedAssistantId(assistantId);
    });

    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  const isLoading = loadedAssistantId !== assistantId || isAvatarLoading;
  const [constellationFullscreen, setConstellationFullscreen] = useState(false);

  const skillsQuery = useQuery({
    queryKey: ["assistantSkills", assistantId, { kind: "installed" }],
    queryFn: () => fetchSkills(assistantId, { kind: "installed" }),
    enabled: Boolean(assistantId),
  });
  const installedSkills = useMemo(() => skillsQuery.data?.skills ?? [], [skillsQuery.data?.skills]);

  const handleAvatarChange = useCallback(() => {
    invalidateAvatar();
  }, [invalidateAvatar]);

  const handleOpenModal = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    onOpenThread?.("I'd like to create a custom AI-generated avatar.");
  }, [onOpenThread]);

  const handleDeleteAvatar = useCallback(async () => {
    const ok = await deleteAvatar(assistantId);
    if (ok) {
      invalidateAvatar();
    }
  }, [assistantId, invalidateAvatar]);

  const invalidateSkills = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["assistantSkills", assistantId],
    });
  }, [assistantId, queryClient]);

  const installMutation = useMutation({
    mutationFn: (slug: string) => installSkill(assistantId, slug),
    onMutate: (slug) => setInstallingSkillId(slug),
    onSettled: () => {
      setInstallingSkillId(null);
      invalidateSkills();
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (id: string) => uninstallSkill(assistantId, id),
    onMutate: (id) => setRemovingSkillId(id),
    onSettled: () => {
      setRemovingSkillId(null);
      invalidateSkills();
    },
  });

  const handleInstall = useCallback(
    (skill: SkillInfo) => {
      installMutation.mutate(skill.slug ?? skill.id);
    },
    [installMutation],
  );

  const handleRemove = useCallback((skill: SkillInfo) => {
    setSkillPendingRemoval(skill);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!skillPendingRemoval) {
      return;
    }
    uninstallMutation.mutate(skillPendingRemoval.id);
    setSkillPendingRemoval(null);
  }, [skillPendingRemoval, uninstallMutation]);

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) {
      return null;
    }
    return installedSkills.find((s) => s.id === selectedSkillId) ?? null;
  }, [installedSkills, selectedSkillId]);

  const removalDialog = (
    <ConfirmDialog
      open={skillPendingRemoval !== null}
      title="Remove skill"
      message={
        skillPendingRemoval
          ? `Remove "${skillPendingRemoval.name}" from this assistant?`
          : ""
      }
      confirmLabel="Remove"
      destructive
      onConfirm={confirmRemove}
      onCancel={() => setSkillPendingRemoval(null)}
    />
  );

  if (selectedSkill) {
    return (
      <>
        <SkillDetail
          assistantId={assistantId}
          skill={selectedSkill}
          onBack={() => setSelectedSkillId(null)}
          onInstall={() => handleInstall(selectedSkill)}
          onRemove={() => handleRemove(selectedSkill)}
          isInstalling={installingSkillId === (selectedSkill.slug ?? selectedSkill.id)}
          isRemoving={removingSkillId === selectedSkill.id}
        />
        {removalDialog}
      </>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          style={{
            borderColor: "var(--border-base)",
            borderTopColor: "var(--content-tertiary)",
          }}
        />
      </div>
    );
  }

  const assistantName = identity?.name || "Assistant";
  const assistantPersonality = identity?.personality || "";
  const assistantRole = identity?.role || "Not set";
  const hatchedDate = assistantCreatedAt
    ? new Date(assistantCreatedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Unknown";

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 lg:flex-row lg:items-stretch">
      <div
        className={`mx-auto w-full max-w-md lg:mx-0 lg:h-full lg:shrink-0 lg:overflow-y-auto ${
          constellationFullscreen ? "hidden" : "flex"
        }`}
      >
        <IdentityCard
          assistantName={assistantName}
          assistantPersonality={assistantPersonality}
          assistantRole={assistantRole}
          hatchedDate={hatchedDate}
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          onOpenThread={onOpenThread}
          onOpenModal={handleOpenModal}
        />
      </div>

      <div className="min-h-[480px] min-w-0 flex-1 lg:min-h-0">
        <ConstellationView
          skills={installedSkills}
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          className="h-full w-full"
          isFullscreen={constellationFullscreen}
          onToggleFullscreen={() => setConstellationFullscreen((v) => !v)}
          onSelectSkill={setSelectedSkillId}
        />
      </div>

      <AvatarManagementModal
        open={modalOpen}
        onClose={handleCloseModal}
        assistantId={assistantId}
        components={components}
        traits={traits}
        customImageUrl={customImageUrl}
        onSaveCharacter={handleAvatarChange}
        onUploadImage={handleAvatarChange}
        onGenerateWithAI={onOpenThread ? handleGenerateWithAI : undefined}
        onDeleteAvatar={handleDeleteAvatar}
      />
      {removalDialog}
    </div>
  );
}
