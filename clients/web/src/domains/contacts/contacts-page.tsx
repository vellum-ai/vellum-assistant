import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import { isVerifiedContactChannel } from "@/domains/contacts/channel-linking";
import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import { ContactDetailView } from "@/domains/contacts/components/contact-detail-view";
import { ContactMergeDialog } from "@/domains/contacts/components/contact-merge-dialog";
import { ContactsList } from "@/domains/contacts/components/contacts-list";
import { GenerateInviteLinkDialog } from "@/components/generate-invite-link-dialog";
import { GuardianDetailView } from "@/domains/contacts/components/guardian-detail-view";
import { LinkAccountDialog } from "@/domains/contacts/components/link-account-dialog";
import { slackRosterOptions } from "@/domains/contacts/slack-users-query";
import {
  deleteContact as gatewayDeleteContact,
  upsertContact,
  verifyContactChannel,
} from "@/domains/contacts/contacts-gateway";
import type {
  ChannelInfo,
  ContactChannelPayload,
  ContactPayload,
  ContactSelection,
} from "@/domains/contacts/types";
import { isSetupChannelId } from "@/types/channel-types";
import {
  channelsAvailableGetOptions,
  contactsGetOptions,
  contactsGetQueryKey,
  contactsGetSetQueryData,
  useContactchannelsByContactChannelIdPatchMutation,
  useContactsMergePostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { channelsAvailableGet } from "@/generated/daemon/sdk.gen";
import type { ChannelsAvailableGetResponse } from "@/generated/daemon/types.gen";
import { assistantDisplayName } from "@/utils/assistant-display-name";
import { useAssistantChannels } from "@/hooks/use-assistant-channels";
import { useChannelProvenance } from "@/domains/contacts/hooks/use-channel-provenance";
import { useInviteLinkDialog } from "@/hooks/use-invite-link-dialog";
import { useAccountLink } from "@/domains/contacts/hooks/use-account-link";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { toastOnError } from "@/utils/mutation-error";
import { routes } from "@/utils/routes";

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
  // Legacy `?setup=<channel>` deep link. Setup used to continue on this
  // page's assistant detail card; the credential forms now live only on the
  // Channels tab, so the param is forwarded there (see the redirect below)
  // instead of being consumed via `useSetupChannelParam`.
  const [searchParams] = useSearchParams();
  const rawSetupParam = searchParams.get("setup");
  const setupChannel =
    rawSetupParam && isSetupChannelId(rawSetupParam) ? rawSetupParam : null;

  const [selection, setSelection] = useState<ContactSelection>({
    kind: "assistant",
  });

  const inviteDialog = useInviteLinkDialog(assistantId);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

  const assistantName = assistantDisplayName(identityName);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const contactsPathOpts = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const contactsQueryKey = contactsGetQueryKey(contactsPathOpts);

  const contactsQuery = useQuery({
    ...contactsGetOptions(contactsPathOpts),
    enabled: Boolean(assistantId),
    select: (data) => data.contacts,
  });

  const channelsController = useAssistantChannels({
    assistantId,
    onStartSetupConversation,
  });

  const channelProvenance = useChannelProvenance(assistantId);

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
        return {
          channels: DEFAULT_CHANNELS,
        } satisfies ChannelsAvailableGetResponse;
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

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateContacts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: contactsQueryKey }),
    [queryClient, contactsQueryKey],
  );

  const createMutation = useMutation({
    mutationFn: () =>
      upsertContact(assistantId, { displayName: "New Contact" }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: contactsQueryKey });
    },
    onSuccess: (contact) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev ? { ...prev, contacts: [...prev.contacts, contact] } : undefined,
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
                  .map((c) => (c.id === mergedContact.id ? mergedContact : c)),
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

  const handleAddContact = useCallback(() => {
    if (createMutation.isPending) return;
    createMutation.mutate();
  }, [createMutation]);

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

  const slackLink = useAccountLink({
    assistantId,
    channelType: "slack",
    contact: selectedContact
      ? { id: selectedContact.id, displayName: selectedContact.displayName }
      : null,
    onLinked: invalidateContacts,
  });

  // Roster fetch is deferred until the picker opens.
  const slackRosterQuery = useQuery({
    ...slackRosterOptions(assistantId),
    enabled: Boolean(assistantId) && slackLink.dialogOpen,
    select: (data) => data.users,
  });

  // Without configured Slack credentials the roster can only 503, so the
  // Link action is offered only when the Slack connection is ready —
  // otherwise the row keeps Invite as its sole (working) action.
  const slackReady = channelsController.channels.some(
    (channel) => channel.key === "slack" && channel.status === "ready",
  );

  const handleLinkAccount = useCallback(
    (channelId: string) => {
      if (channelId === slackLink.channelType) {
        slackLink.open();
      }
    },
    [slackLink],
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

  // Old builds' mobile chat handoff (and saved links) deep-linked channel
  // setup to this page. The forms it targeted moved to the Channels tab,
  // so forward the link there rather than stranding it on the assistant
  // card's plain connect/disconnect list.
  if (setupChannel) {
    return <Navigate to={`${routes.channels}?setup=${setupChannel}`} replace />;
  }

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
        verified: isVerifiedContact(c.channels),
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
            channels={channelsController.channels}
            pendingChannelKey={channelsController.pendingChannelKey}
            onConnect={channelsController.onSetup}
            onDisconnect={channelsController.onDisconnect}
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
                onStartSetupConversation
                  ? handleGuardianEnableChannel
                  : undefined
              }
              onVerifyChannel={handleVerifyChannel}
              onRevokeChannel={handleRevokeChannel}
              onGenerateInviteLink={a2aChannel ? inviteDialog.open : undefined}
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
              channelProvenance={channelProvenance}
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
              onLinkAccount={slackReady ? handleLinkAccount : undefined}
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

      <LinkAccountDialog
        open={slackLink.dialogOpen}
        channelLabel="Slack"
        contactName={selectedContact?.displayName ?? ""}
        accounts={slackRosterQuery.data}
        loading={slackRosterQuery.isLoading}
        errorMessage={
          slackRosterQuery.isError
            ? "Couldn’t load the workspace roster. Check the Slack connection and try again."
            : slackLink.linkErrorMessage
        }
        pendingAccountId={slackLink.pendingAccountId}
        onPick={slackLink.pick}
        onClose={slackLink.close}
        onInviteInstead={
          onStartSetupConversation
            ? () => {
                slackLink.close();
                handleContactSetupChannel(slackLink.channelType);
              }
            : undefined
        }
      />

      <GenerateInviteLinkDialog
        open={inviteDialog.isOpen}
        assistantId={assistantId}
        onClose={inviteDialog.close}
      />
    </div>
  );
}

function ContactsEmptyState() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        Select a contact
      </p>
    </div>
  );
}

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  phone: "Phone",
  email: "Email",
  whatsapp: "WhatsApp",
  a2a: "A2A",
};

/**
 * A contact reads as verified when any non-revoked channel is verified, or is
 * a connected A2A peer (A2A channels never carry a verification handshake).
 */
function isVerifiedContact(channels: ContactChannelPayload[]): boolean {
  return channels.some(
    (ch) =>
      ch.status !== "revoked" &&
      (ch.type === "a2a" || isVerifiedContactChannel(ch)),
  );
}

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
