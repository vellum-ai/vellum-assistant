/**
 * Data container for the voice profile section.
 *
 * Keeps the fetching and mutation wiring out of
 * `ContactDetailView`, which is already threading a wide prop
 * set through to its other sections.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { ContactVoiceprintSection } from "@/domains/contacts/components/contact-voiceprint-section";
import { contactVoiceprintsQueryKey } from "@/domains/contacts/invalidate-voiceprint-queries";
import {
  deleteVoiceprint,
  enrollVoiceprint,
  fileToBase64,
  listVoiceprints,
} from "@/domains/contacts/voiceprints-gateway";
import { useTranslation } from "@/i18n";

interface ContactVoiceprintCardProps {
  assistantId: string;
  contactId: string;
}

export function ContactVoiceprintCard({
  assistantId,
  contactId,
}: ContactVoiceprintCardProps) {
  const { t } = useTranslation("contacts");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const queryKey = useMemo(
    () => contactVoiceprintsQueryKey(assistantId, contactId),
    [assistantId, contactId],
  );

  const { data: voiceprints = [] } = useQuery({
    queryKey,
    enabled: Boolean(assistantId && contactId),
    queryFn: () => listVoiceprints(assistantId, contactId),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const enroll = useMutation({
    mutationFn: async (clips: Blob[]) => {
      const encoded = await Promise.all(clips.map(fileToBase64));
      return enrollVoiceprint(assistantId, contactId, encoded);
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (voiceprintId: string) =>
      deleteVoiceprint(assistantId, voiceprintId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <DetailCard
      title={t("voiceprint.title")}
      subtitle={t("voiceprint.subtitle")}
    >
      <ContactVoiceprintSection
        voiceprints={voiceprints}
        enrollPending={enroll.isPending}
        deletePending={remove.isPending}
        onEnroll={(clips) => enroll.mutate(clips)}
        onDelete={(id) => remove.mutate(id)}
      />
      {error ? <span className="text-sm text-red-600">{error}</span> : null}
    </DetailCard>
  );
}
