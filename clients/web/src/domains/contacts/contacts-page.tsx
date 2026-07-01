import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import {
    MobileSidebarDrawer,
    MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import {
    AssistantChannelsDetail,
    type SlackThreadMode,
} from "@/domains/contacts/components/assistant-channels-detail";
import { ContactDetailView } from "@/domains/contacts/components/contact-detail-view";
import { ContactMergeDialog } from "@/domains/contacts/components/contact-merge-dialog";
import { ContactsList } from "@/domains/contacts/components/contacts-list";
import { GenerateInviteLinkDialog } from "@/domains/contacts/components/generate-invite-link-dialog";
import { GuardianDetailView } from "@/domains/contacts/components/guardian-detail-view";
import {
    deleteContact as gatewayDeleteContact,
    upsertContact,
    verifyContactChannel,
} from "@/domains/contacts/contacts-gateway";
import {
    SETUP_CHANNEL_IDS,
    isSetupChannelId,
    type AssistantChannelState,
    type ChannelInfo,
    type ChannelReadinessSnapshot,
    type ContactChannelPayload,
    type ContactPayload,
    type ContactSelection,
} from "@/domains/contacts/types";
import {
    channelsAvailableGetOptions,
    channelsReadinessGetOptions,
    channelsReadinessGetQueryKey,
    contactsGetOptions,
    contactsGetQueryKey,
    contactsGetSetQueryData,
    integrationsSlackChannelConfigGetOptions,
    integrationsSlackChannelConfigGetQueryKey,
    integrationsSlackChannelConfigPatchMutation,
    useContactchannelsByContactChannelIdPatchMutation,
    useContactsMergePostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
    channelsAvailableGet,
    integrationsSlackChannelConfigDelete,
    integrationsTelegramConfigDelete,
    integrationsTelegramConfigPost,
    integrationsTwilioCredentialsDelete,
    integrationsTwilioCredentialsPost,
} from "@/generated/daemon/sdk.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import type {
    ChannelsAvailableGetResponse,
    IntegrationsSlackChannelConfigGetResponse,
} from "@/generated/daemon/types.gen";
import { useChannelTrustFloors } from "@/domains/contacts/hooks/use-channel-trust-floors";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { toastOnError } from "@/utils/mutation-error";

/**
 * Hardcoded fallback for assistants that don't expose
 * `/v1/channels/available` yet. Needed for backward compatibility
 * with older gateway versions.
 */
const DEFAULT_CHANNELS: ChannelInfo[] = [
  {
    id: "slack",
    label: "Slack",
    subtitle: "Message your assistant from Slack",
    icon: "hash",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Slack. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Slack identity. Can you walk me through it?",
    },
  },
  {
    id: "telegram",
    label: "Telegram",
    subtitle: "Message your assistant from Telegram",
    icon: "send",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Telegram. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Telegram identity. Can you walk me through it?",
    },
  },
  {
    id: "phone",
    label: "Phone Calling",
    subtitle: "Call or text your assistant via phone",
    icon: "phone",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian for phone calls. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's phone number. Can you help me set that up?",
    },
  },
];

const ASSISTANT_SETUP_PROMPTS: Record<AssistantChannelState["key"], string> = {
  slack: "I want to reach you on Slack. Let's set it up.",
  telegram: "I want to reach you on Telegram. Let's set it up.",
  phone: "I want to be able to call you. Let's set you up with a phone number.",
};

const READINESS_REFETCH_MS = 15000;

const EMPTY_CHANNELS: ChannelInfo[] = [];

export interface ContactsPageProps {
  assistantId: string;
  onStartSetupConversation?: (prompt: string) => void;
}

export function ContactsPage({
  assistantId,
  onStartSetupConversation,
}: ContactsPageProps) {
  const a2aChannel = useAssistantFeatureFlagStore.use.a2aChannel();
  const identityName = useAssistantIdentityStore.use.name();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSetup = searchParams.get("setup");
  const setupChannel = rawSetup && isSetupChannelId(rawSetup) ? rawSetup : null;

  // Consume the `?setup=` param once on mount so it doesn't persist across navigations.
  useEffect(() => {
    if (!setupChannel) return;
    setSearchParams((prev) => { prev.delete("setup"); return prev; }, { replace: true });
  }, [setupChannel, setSearchParams]);

  const [selection, setSelection] = useState<ContactSelection>({
    kind: "assistant",
  });

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

  const assistantName = identityName ?? "your assistant";

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const contactsPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const contactsQueryKey = contactsGetQueryKey(contactsPathOpts);
  const readinessPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const readinessQueryKey = channelsReadinessGetQueryKey(readinessPathOpts);

  const contactsQuery = useQuery({
    ...contactsGetOptions(contactsPathOpts),
    enabled: Boolean(assistantId),
    select: (data) => data.contacts,
  });

  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(readinessPathOpts),
    enabled: Boolean(assistantId),
    refetchInterval: READINESS_REFETCH_MS,
    select: (data) => data.snapshots,
  });

  const availabilityQuery = useQuery({
    ...channelsAvailableGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: Boolean(assistantId),
    queryFn: async ({ signal }) => {
      const { data, error, response } = await channelsAvailableGet({
        path: { assistant_id: assistantId },
        signal,
        throwOnError: false,
      });
      if (!response || response.status === 404) {
        return { channels: DEFAULT_CHANNELS } satisfies ChannelsAvailableGetResponse;
      }
      if (!response.ok) {
        throw error ?? new Error("Failed to fetch channel availability");
      }
      return data!;
    },
    select: (data) => data.channels,
  });

  const availableChannels = availabilityQuery.data ?? EMPTY_CHANNELS;

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

  const guardianAutoSelectedRef = useRef(!!setupChannel);
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

  const slackConnected = channels.some(
    (ch) => ch.key === "slack" && ch.status === "ready",
  );

  const slackConfigPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const slackConfigQuery = useQuery({
    ...integrationsSlackChannelConfigGetOptions(slackConfigPathOpts),
    enabled: slackConnected,
    select: (data: IntegrationsSlackChannelConfigGetResponse) => data.threadMode,
  });

  const slackThreadMode = slackConfigQuery.data;

  // Per-channel trust floors (admission policy), shown inline on each connected
  // channel when the `channelTrustFloors` flag is on.
  const channelTrustFloors = useChannelTrustFloors(assistantId);

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateContacts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: contactsQueryKey }),
    [queryClient, contactsQueryKey],
  );

  const invalidateReadiness = useCallback(
    () => queryClient.invalidateQueries({ queryKey: readinessQueryKey }),
    [queryClient, readinessQueryKey],
  );

  const createMutation = useMutation({
    mutationFn: () =>
      upsertContact(assistantId, { displayName: "New Contact" }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: contactsQueryKey });
    },
    onSuccess: (contact) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev
          ? { ...prev, contacts: [...prev.contacts, contact] }
          : undefined,
      );
      setSelection({ kind: "contact", contactId: contact.id });
    },
    onError: toastOnError("Failed to create contact"),
    onSettled: () => invalidateContacts(),
  });

  const deleteMutation = useMutation({
    mutationFn: (contactId: string) =>
      gatewayDeleteContact(assistantId, contactId),
    onSuccess: (_data, contactId) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev
          ? {
              ...prev,
              contacts: prev.contacts.filter((c) => c.id !== contactId),
            }
          : undefined,
      );
      setSelection({ kind: "assistant" });
    },
    onError: toastOnError("Failed to delete contact"),
    onSettled: () => invalidateContacts(),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      contactId,
      patch,
    }: {
      contactId: string;
      patch: { displayName: string; notes: string };
    }) =>
      upsertContact(assistantId, {
        id: contactId,
        displayName: patch.displayName,
        notes: patch.notes,
      }),
    onSuccess: (updatedContact) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev
          ? {
              ...prev,
              contacts: prev.contacts.map((c) =>
                c.id === updatedContact.id ? updatedContact : c,
              ),
            }
          : undefined,
      );
    },
    onError: toastOnError("Failed to save contact"),
    onSettled: () => invalidateContacts(),
  });

  const mergeMutation = useContactsMergePostMutation({
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: contactsQueryKey });
    },
    onSuccess: (mergedData, variables) => {
      const mergedContact = mergedData.contact;
      const mergeId = variables.body.mergeId;
      if (mergedContact) {
        contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
          prev
            ? {
                ...prev,
                contacts: prev.contacts
                  .filter((c) => c.id !== mergeId)
                  .map((c) =>
                    c.id === mergedContact.id ? mergedContact : c,
                  ),
              }
            : undefined,
        );
        setSelection({ kind: "contact", contactId: mergedContact.id });
      }
      setMergeDialogOpen(false);
      toast.success("Contacts merged");
    },
    onSettled: () => invalidateContacts(),
  });

  const handleSelect = useCallback(
    (sel: ContactSelection) => {
      setSelection(sel);
      setDrawerOpen(false);
      setMergeDialogOpen(false);
      mergeMutation.reset();
    },
    [mergeMutation],
  );

  const handleOpenMerge = useCallback(() => {
    mergeMutation.reset();
    setMergeDialogOpen(true);
  }, [mergeMutation]);

  const handleCloseMerge = useCallback(() => {
    if (mergeMutation.isPending) return;
    setMergeDialogOpen(false);
    mergeMutation.reset();
  }, [mergeMutation]);

  const disconnectMutation = useMutation({
    mutationFn: async (channelKey: AssistantChannelState["key"]) => {
      const opts = { path: { assistant_id: assistantId }, throwOnError: true as const };
      if (channelKey === "slack") {
        await integrationsSlackChannelConfigDelete(opts);
      } else if (channelKey === "telegram") {
        await integrationsTelegramConfigDelete(opts);
      } else if (channelKey === "phone") {
        await integrationsTwilioCredentialsDelete(opts);
      }
    },
    onSettled: () => invalidateReadiness(),
  });

  const revokeMutation = useContactchannelsByContactChannelIdPatchMutation({
    onSuccess: () => invalidateContacts(),
  });

  const handleRevokeChannel = useCallback(
    (channelId: string, _type: string) => {
      revokeMutation.mutate({
        path: { assistant_id: assistantId, contactChannelId: channelId },
        body: { status: "revoked" },
      });
    },
    [revokeMutation, assistantId],
  );

  const saveTelegramMutation = useMutation({
    mutationFn: (botToken: string) =>
      integrationsTelegramConfigPost({
        path: { assistant_id: assistantId },
        body: { botToken },
        throwOnError: true,
      }),
    onSettled: () => invalidateReadiness(),
  });

  const saveSlackMutation = useSaveSlackConfig({ assistantId });

  const slackThreadModeMutation = useMutation({
    ...integrationsSlackChannelConfigPatchMutation(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: integrationsSlackChannelConfigGetQueryKey(slackConfigPathOpts),
      });
    },
  });

  const saveTwilioMutation = useMutation({
    mutationFn: ({ accountSid, authToken }: { accountSid: string; authToken: string }) =>
      integrationsTwilioCredentialsPost({
        path: { assistant_id: assistantId },
        body: { accountSid, authToken },
        throwOnError: true,
      }),
    onSettled: () => invalidateReadiness(),
  });

  const handleSaveTelegramToken = useCallback(
    async (botToken: string): Promise<void> => {
      await saveTelegramMutation.mutateAsync(botToken);
    },
    [saveTelegramMutation],
  );

  const handleSaveSlackConfig = useCallback(
    (botToken: string, appToken: string) => {
      saveSlackMutation.mutate({ botToken, appToken });
    },
    [saveSlackMutation],
  );

  const handleSlackThreadModeChange = useCallback(
    (mode: SlackThreadMode) => {
      slackThreadModeMutation.mutate({
        path: { assistant_id: assistantId },
        body: { threadMode: mode },
      });
    },
    [slackThreadModeMutation, assistantId],
  );

  const handleSaveTwilioCredentials = useCallback(
    async (accountSid: string, authToken: string): Promise<void> => {
      await saveTwilioMutation.mutateAsync({ accountSid, authToken });
    },
    [saveTwilioMutation],
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
      onStartSetupConversation(ASSISTANT_SETUP_PROMPTS[channelKey]);
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
    onError: toastOnError("Failed to verify channel"),
  });

  const handleVerifyChannel = useCallback(
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
  // Derived optimistic state
  // ---------------------------------------------------------------------------

  const deletingContactId = deleteMutation.isPending
    ? deleteMutation.variables
    : null;

  const optimisticContact = useMemo<ContactPayload | null>(() => {
    if (!selectedContact) return null;
    if (
      updateMutation.isPending &&
      updateMutation.variables?.contactId === selectedContact.id
    ) {
      return {
        ...selectedContact,
        displayName: updateMutation.variables.patch.displayName,
        notes: updateMutation.variables.patch.notes,
      };
    }
    return selectedContact;
  }, [selectedContact, updateMutation.isPending, updateMutation.variables]);

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
    regularContacts: regularContacts
      .filter((c) => c.id !== deletingContactId)
      .map((c) => ({
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
        {selection.kind === "assistant" ||
        (selection.kind === "contact" &&
          selection.contactId === deletingContactId) ? (
          <AssistantChannelsDetail
            assistantName={assistantName}
            channels={channels}
            pendingChannelKey={
              disconnectMutation.isPending
                ? disconnectMutation.variables ?? null
                : null
            }
            slackThreadMode={slackThreadMode}
            slackThreadModePending={slackThreadModeMutation.isPending}
            channelPolicies={channelTrustFloors.policies}
            policySavingKey={channelTrustFloors.savingKey}
            policiesLoading={channelTrustFloors.isLoading}
            policiesError={channelTrustFloors.isError}
            onChannelPolicyChange={channelTrustFloors.onChange}
            onSetup={onStartSetupConversation ? handleAssistantSetup : undefined}
            onDisconnect={handleDisconnect}
            onSaveTelegramToken={handleSaveTelegramToken}
            onSaveSlackConfig={handleSaveSlackConfig}
            slackSaveStatus={saveSlackMutation.status}
            slackSaveError={saveSlackMutation.error?.message ?? null}
            onSlackThreadModeChange={handleSlackThreadModeChange}
            onSaveTwilioCredentials={handleSaveTwilioCredentials}
            onGenerateInviteLink={a2aChannel ? handleOpenInviteLink : undefined}
            initialExpandedChannel={setupChannel}
          />
        ) : optimisticContact ? (
          optimisticContact.role === "guardian" ? (
            <GuardianDetailView
              contact={optimisticContact}
              savePending={updateMutation.isPending}
              verifyPending={verifyChannelMutation.isPending}
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              a2aEnabled={a2aChannel}
              onSave={(patch) => {
                updateMutation.mutate({
                  contactId: optimisticContact.id,
                  patch,
                });
              }}
              onMerge={handleOpenMerge}
              onSetupChannel={
                onStartSetupConversation ? handleGuardianEnableChannel : undefined
              }
              onVerifyChannel={handleVerifyChannel}
              onRevokeChannel={handleRevokeChannel}
              onGenerateInviteLink={a2aChannel ? handleOpenInviteLink : undefined}
            />
          ) : (
            <ContactDetailView
              contact={optimisticContact}
              savePending={updateMutation.isPending}
              deletePending={deleteMutation.isPending}
              verifyPending={verifyChannelMutation.isPending}
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              a2aEnabled={a2aChannel}
              onSave={(patch) => {
                updateMutation.mutate({
                  contactId: optimisticContact.id,
                  patch,
                });
              }}
              onDelete={() => {
                deleteMutation.mutate(optimisticContact.id);
              }}
              onMerge={handleOpenMerge}
              onSetupChannel={
                onStartSetupConversation ? handleContactSetupChannel : undefined
              }
              onVerifyChannel={handleVerifyChannel}
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
          errorMessage={
            mergeMutation.error instanceof Error
              ? mergeMutation.error.message
              : mergeMutation.error
                ? "Failed to merge contacts"
                : null
          }
          onMerge={(donorId) =>
            mergeMutation.mutate({
              path: { assistant_id: assistantId },
              body: {
                keepId: selectedContact.id,
                mergeId: donorId,
              },
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
  const byChannel = new Map<ChannelReadinessSnapshot["channel"], ChannelReadinessSnapshot>();
  for (const snap of snapshots) {
    byChannel.set(snap.channel, snap);
  }

  return SETUP_CHANNEL_IDS.map((key) => {
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
