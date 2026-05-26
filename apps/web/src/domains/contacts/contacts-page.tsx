import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "@vellum/design-library/components/toast";

import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer.js";
import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail.js";
import { ContactDetailView } from "@/domains/contacts/components/contact-detail-view.js";
import { GenerateInviteLinkDialog } from "@/domains/contacts/components/generate-invite-link-dialog.js";
import { ContactMergeDialog } from "@/domains/contacts/components/contact-merge-dialog.js";
import { ContactsList } from "@/domains/contacts/components/contacts-list.js";
import { GuardianDetailView } from "@/domains/contacts/components/guardian-detail-view.js";
import {
  clearTelegramConfig,
  clearTwilioCredentials,
  createContact,
  deleteContact as apiDeleteContact,
  deleteSlackChannelConfig,
  fetchChannelAvailability,
  fetchChannelReadiness,
  listContacts,
  mergeContacts as apiMergeContacts,
  revokeContactChannel,
  setSlackChannelConfig,
  setTelegramConfig,
  setTwilioCredentials,
  updateContact as apiUpdateContact,
  verifyContactChannel,
} from "@/domains/contacts/api.js";
import type {
  AssistantChannelState,
  ChannelInfo,
  ChannelReadinessSnapshot,
  ContactChannelPayload,
  ContactPayload,
  ContactSelection,
} from "@/domains/contacts/types.js";
import { fetchAssistantIdentity } from "@/assistant/identity.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";

const ASSISTANT_SETUP_PROMPTS: Record<AssistantChannelState["key"], string> = {
  slack: "I want to reach you on Slack. Let's set it up.",
  telegram: "I want to reach you on Telegram. Let's set it up.",
  phone: "I want to be able to call you. Let's set you up with a phone number.",
};

const READINESS_REFETCH_MS = 15000;

export interface ContactsPageProps {
  assistantId: string;
  onStartSetupConversation?: (prompt: string) => void;
}

export function ContactsPage({
  assistantId,
  onStartSetupConversation,
}: ContactsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  const queryClient = useQueryClient();
  const [loadedName, setLoadedName] = useState<{
    assistantId: string;
    name: string;
  } | null>(null);
  const [selection, setSelection] = useState<ContactSelection>({
    kind: "assistant",
  });
  const [pendingChannelKey, setPendingChannelKey] =
    useState<AssistantChannelState["key"] | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleSelect = useCallback((sel: ContactSelection) => {
    setSelection(sel);
    setDrawerOpen(false);
    setMergeDialogOpen(false);
    setMergeError(null);
  }, []);

  const handleOpenMerge = useCallback(() => {
    setMergeError(null);
    setMergeDialogOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAssistantIdentity(assistantId).then((identity) => {
      if (cancelled) return;
      if (identity?.name) {
        setLoadedName({ assistantId, name: identity.name });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  const assistantName =
    loadedName && loadedName.assistantId === assistantId
      ? loadedName.name
      : "your assistant";

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const contactsQuery = useQuery({
    queryKey: ["assistantContacts", assistantId],
    queryFn: () => listContacts(assistantId),
    enabled: Boolean(assistantId),
  });

  const readinessQuery = useQuery({
    queryKey: ["assistantChannelReadiness", assistantId],
    queryFn: () => fetchChannelReadiness(assistantId),
    enabled: Boolean(assistantId),
    refetchInterval: READINESS_REFETCH_MS,
  });

  const availabilityQuery = useQuery({
    queryKey: ["assistantChannelAvailability", assistantId],
    queryFn: () => fetchChannelAvailability(assistantId),
    enabled: Boolean(assistantId),
  });

  const availableChannels = useMemo<ChannelInfo[]>(
    () => availabilityQuery.data ?? [],
    [availabilityQuery.data],
  );

  const contactsData = contactsQuery.data;
  const guardian = useMemo(
    () => contactsData?.find((c) => c.role === "guardian") ?? null,
    [contactsData],
  );
  const regularContacts = useMemo(
    () => contactsData?.filter((c) => c.role !== "guardian") ?? [],
    [contactsData],
  );
  const selectedContact = useMemo<ContactPayload | null>(() => {
    if (selection.kind !== "contact") return null;
    return contactsData?.find((c) => c.id === selection.contactId) ?? null;
  }, [contactsData, selection]);
  const readinessData = readinessQuery.data ?? [];

  const mergeCandidates = useMemo<ContactPayload[]>(() => {
    if (!contactsData || !selectedContact) return [];
    return contactsData.filter(
      (c) => c.id !== selectedContact.id && c.role !== "guardian",
    );
  }, [contactsData, selectedContact]);
  const canMerge = mergeCandidates.length > 0;

  const guardianAutoSelectedRef = useRef(false);
  useEffect(() => {
    if (guardianAutoSelectedRef.current) return;
    if (!guardian) return;
    guardianAutoSelectedRef.current = true;
    setSelection({ kind: "contact", contactId: guardian.id });
  }, [guardian]);

  const channels = useMemo(
    () => deriveChannelStates(readinessData),
    [readinessData],
  );

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateContacts = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["assistantContacts", assistantId],
    });
  }, [queryClient, assistantId]);

  const invalidateReadiness = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["assistantChannelReadiness", assistantId],
    });
  }, [queryClient, assistantId]);

  const createMutation = useMutation({
    mutationFn: () =>
      createContact(assistantId, { displayName: "New Contact" }),
    onSuccess: (contact) => {
      queryClient.setQueryData<ContactPayload[]>(
        ["assistantContacts", assistantId],
        (prev) => (prev ? [...prev, contact] : [contact]),
      );
      invalidateContacts();
      setSelection({ kind: "contact", contactId: contact.id });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (contactId: string) => apiDeleteContact(assistantId, contactId),
    onSuccess: (_data, contactId) => {
      queryClient.setQueryData<ContactPayload[]>(
        ["assistantContacts", assistantId],
        (prev) => prev?.filter((c) => c.id !== contactId) ?? [],
      );
      setSelection({ kind: "assistant" });
      invalidateContacts();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      contactId,
      patch,
    }: {
      contactId: string;
      patch: { displayName: string; notes: string };
    }) => apiUpdateContact(assistantId, contactId, patch),
    onSuccess: (updatedContact) => {
      queryClient.setQueryData<ContactPayload[]>(
        ["assistantContacts", assistantId],
        (prev) =>
          prev?.map((c) => (c.id === updatedContact.id ? updatedContact : c)) ?? [],
      );
      invalidateContacts();
    },
  });

  const mergeMutation = useMutation({
    mutationFn: ({
      keepId,
      mergeId,
    }: {
      keepId: string;
      mergeId: string;
    }) => apiMergeContacts(assistantId, keepId, mergeId),
    onSuccess: (mergedContact, { mergeId }) => {
      queryClient.setQueryData<ContactPayload[]>(
        ["assistantContacts", assistantId],
        (prev) =>
          prev
            ?.filter((c) => c.id !== mergeId)
            .map((c) => (c.id === mergedContact.id ? mergedContact : c)) ?? [],
      );
      invalidateContacts();
      setSelection({ kind: "contact", contactId: mergedContact.id });
      setMergeDialogOpen(false);
      setMergeError(null);
      toast.success("Contacts merged");
    },
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Failed to merge contacts";
      setMergeError(message);
    },
  });

  const handleCloseMerge = useCallback(() => {
    if (mergeMutation.isPending) return;
    setMergeDialogOpen(false);
    setMergeError(null);
  }, [mergeMutation.isPending]);

  const disconnectMutation = useMutation({
    mutationFn: async (channelKey: AssistantChannelState["key"]) => {
      if (channelKey === "slack") {
        await deleteSlackChannelConfig(assistantId);
      } else if (channelKey === "telegram") {
        await clearTelegramConfig(assistantId);
      } else if (channelKey === "phone") {
        await clearTwilioCredentials(assistantId);
      }
    },
    onMutate: (channelKey) => setPendingChannelKey(channelKey),
    onSettled: () => {
      setPendingChannelKey(null);
      invalidateReadiness();
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (args: { channelId: string }) =>
      revokeContactChannel(assistantId, args.channelId),
    onSuccess: () => invalidateContacts(),
  });

  const handleRevokeChannel = useCallback(
    (channelId: string, _type: string) => {
      revokeMutation.mutate({ channelId });
    },
    [revokeMutation],
  );

  const handleSaveTelegramToken = useCallback(
    async (botToken: string) => {
      await setTelegramConfig(assistantId, botToken);
      invalidateReadiness();
    },
    [assistantId, invalidateReadiness],
  );

  const handleSaveSlackConfig = useCallback(
    async (botToken: string, appToken: string) => {
      await setSlackChannelConfig(assistantId, botToken, appToken);
      invalidateReadiness();
    },
    [assistantId, invalidateReadiness],
  );

  const handleSaveTwilioCredentials = useCallback(
    async (accountSid: string, authToken: string) => {
      await setTwilioCredentials(assistantId, accountSid, authToken);
      invalidateReadiness();
    },
    [assistantId, invalidateReadiness],
  );

  const handleAddContact = useCallback(() => {
    if (createMutation.isPending) return;
    createMutation.mutate();
  }, [createMutation]);

  const handleOpenInviteLink = useCallback(() => {
    setInviteDialogOpen(true);
  }, []);

  const handleInviteClose = useCallback(() => {
    setInviteDialogOpen(false);
    invalidateContacts();
  }, [invalidateContacts]);

  const handleAssistantSetup = useCallback(
    (channelKey: AssistantChannelState["key"]) => {
      if (!onStartSetupConversation) return;
      setPendingChannelKey(channelKey);
      onStartSetupConversation(ASSISTANT_SETUP_PROMPTS[channelKey]);
      window.setTimeout(() => setPendingChannelKey(null), 1000);
    },
    [onStartSetupConversation],
  );

  const handleDisconnect = useCallback(
    (channelKey: AssistantChannelState["key"]) => {
      disconnectMutation.mutate(channelKey);
    },
    [disconnectMutation],
  );

  const handleContactSetupChannel = useCallback(
    (type: string) => {
      if (!onStartSetupConversation) {
        return;
      }
      const info = availableChannels.find((ch) => ch.id === type);
      const prompt = info?.setupMessages.contact;
      if (!prompt) {
        return;
      }
      onStartSetupConversation(prompt);
    },
    [availableChannels, onStartSetupConversation],
  );

  const handleGuardianEnableChannel = useCallback(
    (type: string) => {
      if (!onStartSetupConversation) {
        return;
      }
      const info = availableChannels.find((ch) => ch.id === type);
      const prompt = info?.setupMessages.guardian;
      if (!prompt) {
        return;
      }
      onStartSetupConversation(prompt);
    },
    [availableChannels, onStartSetupConversation],
  );

  const verifyChannelMutation = useMutation({
    mutationFn: (args: { channelId: string }) =>
      verifyContactChannel(assistantId, args.channelId),
    onSuccess: () => invalidateContacts(),
    onError: (err) => {
      const message =
        err instanceof Error ? err.message : "Failed to verify channel";
      toast.error(message);
    },
  });

  const handleGuardianVerifyChannel = useCallback(
    (type: string) => {
      if (!selectedContact) return;
      const channel = selectedContact.channels.find(
        (ch) => ch.type === type && ch.status !== "revoked",
      );
      if (!channel) return;
      verifyChannelMutation.mutate({ channelId: channel.id });
    },
    [selectedContact, verifyChannelMutation],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const contactsListProps = {
    loading: contactsQuery.isLoading,
    assistantName: assistantName,
    guardian: guardian
      ? {
          id: guardian.id,
          displayName: guardian.displayName.startsWith("vellum-principal-")
            ? ""
            : guardian.displayName,
          role: guardian.role,
          channelTypes: channelTypeLabels(guardian.channels, a2aChannel),
        }
      : null,
    regularContacts: regularContacts.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      role: c.role,
      contactType: c.contactType,
      channelTypes: channelTypeLabels(c.channels, a2aChannel),
    })),
    selection,
    onAddContact: handleAddContact,
    addingContact: createMutation.isPending,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden sm:flex-row sm:gap-6">
      <div className="flex items-center sm:hidden">
        <MobileSidebarTrigger onClick={() => setDrawerOpen(true)} />
      </div>

      <MobileSidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Contacts"
      >
        <ContactsList {...contactsListProps} onSelect={handleSelect} />
      </MobileSidebarDrawer>

      <aside className="hidden min-h-0 w-[320px] shrink-0 overflow-y-auto self-stretch sm:block">
        <ContactsList {...contactsListProps} onSelect={handleSelect} />
      </aside>

      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selection.kind === "assistant" ? (
          <AssistantChannelsDetail
            assistantName={assistantName}
            channels={channels}
            pendingChannelKey={pendingChannelKey}
            onSetup={onStartSetupConversation ? handleAssistantSetup : undefined}
            onDisconnect={handleDisconnect}
            onSaveTelegramToken={handleSaveTelegramToken}
            onSaveSlackConfig={handleSaveSlackConfig}
            onSaveTwilioCredentials={handleSaveTwilioCredentials}
            onGenerateInviteLink={a2aChannel ? handleOpenInviteLink : undefined}
          />
        ) : selectedContact ? (
          selectedContact.role === "guardian" ? (
            <GuardianDetailView
              contact={selectedContact}
              savePending={updateMutation.isPending}
              verifyPending={verifyChannelMutation.isPending}
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              a2aEnabled={a2aChannel}
              onSave={async (patch) => {
                await updateMutation.mutateAsync({
                  contactId: selectedContact.id,
                  patch,
                });
              }}
              onMerge={handleOpenMerge}
              onSetupChannel={
                onStartSetupConversation ? handleGuardianEnableChannel : undefined
              }
              onVerifyChannel={handleGuardianVerifyChannel}
              onRevokeChannel={handleRevokeChannel}
              onGenerateInviteLink={a2aChannel ? handleOpenInviteLink : undefined}
            />
          ) : (
            <ContactDetailView
              contact={selectedContact}
              savePending={updateMutation.isPending}
              deletePending={deleteMutation.isPending}
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              a2aEnabled={a2aChannel}
              onSave={async (patch) => {
                await updateMutation.mutateAsync({
                  contactId: selectedContact.id,
                  patch,
                });
              }}
              onDelete={async () => {
                await deleteMutation.mutateAsync(selectedContact.id);
              }}
              onMerge={handleOpenMerge}
              onSetupChannel={
                onStartSetupConversation ? handleContactSetupChannel : undefined
              }
              onRevokeChannel={handleRevokeChannel}
            />
          )
        ) : (
          <ContactsEmptyState />
        )}
      </section>

      {selectedContact ? (
        <ContactMergeDialog
          open={mergeDialogOpen}
          survivor={selectedContact}
          candidates={mergeCandidates}
          pending={mergeMutation.isPending}
          errorMessage={mergeError}
          onMerge={(donorId) =>
            mergeMutation.mutate({
              keepId: selectedContact.id,
              mergeId: donorId,
            })
          }
          onClose={handleCloseMerge}
        />
      ) : null}

      <GenerateInviteLinkDialog
        open={inviteDialogOpen}
        assistantId={assistantId}
        onClose={handleInviteClose}
      />
    </div>
  );
}

function ContactsEmptyState() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <p className="text-body-medium-lighter" style={{ color: "var(--content-tertiary)" }}>
        Select a contact
      </p>
    </div>
  );
}

function deriveChannelStates(
  snapshots: ChannelReadinessSnapshot[],
): AssistantChannelState[] {
  const byChannel = new Map<string, ChannelReadinessSnapshot>();
  for (const snap of snapshots) {
    byChannel.set(snap.channel, snap);
  }

  const order: AssistantChannelState["key"][] = ["slack", "telegram", "phone"];
  return order.map((key) => {
    const snap = byChannel.get(key);
    const status = toChannelStatus(snap);
    return {
      key,
      status,
      address: snap?.channelHandle ?? undefined,
    };
  });
}

function toChannelStatus(
  snap: ChannelReadinessSnapshot | undefined,
): AssistantChannelState["status"] {
  if (!snap) {
    return "not_configured";
  }
  if (snap.ready || snap.setupStatus === "ready") {
    return "ready";
  }
  if (snap.setupStatus === "incomplete") {
    return "incomplete";
  }
  return "not_configured";
}

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  phone: "Phone",
  email: "Email",
  whatsapp: "WhatsApp",
  a2a: "A2A",
};

function channelTypeLabels(
  channels: ContactChannelPayload[],
  a2aEnabled?: boolean,
): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const ch of channels) {
    if (ch.status === "revoked") {
      continue;
    }
    const key = ch.type.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    if (key === "a2a" && !a2aEnabled) {
      continue;
    }
    seen.add(key);
    labels.push(CHANNEL_TYPE_LABEL[key] ?? ch.type);
  }
  return labels;
}
