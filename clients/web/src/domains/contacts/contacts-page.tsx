import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { SideListDrawer, SideListTrigger } from "@/components/side-list-drawer";
import { useSideListRoom } from "@/hooks/use-side-list-room";
import { isVerifiedContactChannel } from "@/domains/contacts/channel-linking";
import { channelTypeLabel } from "@/domains/contacts/channel-type-labels";
import { DRAFT_CONTACT_NAME } from "@/domains/contacts/draft-contact";
import { AssistantChannelsDetail } from "@/domains/contacts/components/assistant-channels-detail";
import { ContactDetailView } from "@/domains/contacts/components/contact-detail-view";
import { isPluginChannel } from "@/domains/contacts/components/contact-channels-section";
import { ContactMergeDialog } from "@/domains/contacts/components/contact-merge-dialog";
import { ContactsList } from "@/domains/contacts/components/contacts-list";
import { GenerateInviteLinkDialog } from "@/components/generate-invite-link-dialog";
import { GuardianDetailView } from "@/domains/contacts/components/guardian-detail-view";
import { LinkAccountDialog } from "@/domains/contacts/components/link-account-dialog";
import { slackRosterOptions } from "@/domains/contacts/slack-users-query";
import {
  deleteContact as gatewayDeleteContact,
  linkContactChannelAccount,
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
import { useTranslation } from "@/i18n";
import { assistantDisplayName } from "@/utils/assistant-display-name";
import { useAssistantChannels } from "@/hooks/use-assistant-channels";
import { useInviteLinkDialog } from "@/hooks/use-invite-link-dialog";
import { useAccountLink } from "@/domains/contacts/hooks/use-account-link";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { toastOnError } from "@/utils/mutation-error";
import { routes } from "@/utils/routes";

/**
 * The channel set for an assistant that serves no `/v1/channels/available`.
 *
 * Holds only channels such an assistant can actually run, which is why it does
 * not track the daemon's list: a row here for a channel that assistant lacks
 * would offer a setup flow that goes nowhere.
 */
const DEFAULT_CHANNELS: ChannelInfo[] = [
  {
    id: "slack",
    source: "default",
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
    source: "default",
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
    source: "default",
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
  const { t } = useTranslation("contacts");
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
  const { paneRef, hasRoomForList, drawerOpen, openDrawer, closeDrawer } =
    useSideListRoom();
  // Above the inline/drawer branch below, which remounts whichever list
  // surface it swaps to: held inside `ContactsList` the filter would be
  // dropped whenever the pane crosses the threshold, and dragging the chat
  // sidebar is enough to cross it.
  const [contactSearch, setContactSearch] = useState("");
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
      // The fallback answers one case: an assistant with no availability
      // route, which serves 404. Any other failure means the channel set is
      // unknown, and a list rendered from a failed request reads as
      // authoritative while naming channels this assistant may not have.
      if (response?.status === 404) {
        return {
          channels: DEFAULT_CHANNELS,
        } satisfies ChannelsAvailableGetResponse;
      }
      if (!response) {
        throw error ?? new Error("Failed to fetch channel availability");
      }
      if (!response.ok) {
        throw error ?? new Error("Failed to fetch channel availability");
      }
      return data!;
    },
    select: (data) => data.channels,
  });

  const availableChannels = availabilityQuery.data ?? EMPTY_CHANNELS;
  // An empty list and a failed lookup both render no channels, so the failure
  // has to say so. Without this the page claims the assistant has no channels
  // to set up, which is a different and wrong statement.
  const channelsLoadFailed = availabilityQuery.isError;

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
    if (selection.kind !== "contact") {
      return null;
    }
    return contactsData?.find((c) => c.id === selection.contactId) ?? null;
  }, [contactsData, selection]);

  const mergeCandidates = useMemo<ContactPayload[]>(() => {
    if (!contactsData || !selectedContact) {
      return [];
    }
    return contactsData.filter(
      (c) => c.id !== selectedContact.id && c.role !== "guardian",
    );
  }, [contactsData, selectedContact]);
  const canMerge = mergeCandidates.length > 0;

  const guardianAutoSelectedRef = useRef(!!setupChannel);
  useEffect(() => {
    if (guardianAutoSelectedRef.current) {
      return;
    }
    if (!guardian) {
      return;
    }
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
      upsertContact(assistantId, { displayName: DRAFT_CONTACT_NAME }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: contactsQueryKey });
    },
    onSuccess: (contact) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev ? { ...prev, contacts: [...prev.contacts, contact] } : undefined,
      );
      setSelection({ kind: "contact", contactId: contact.id });
    },
    onError: toastOnError(t("contactsPage.createFailed")),
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
    onError: toastOnError(t("contactsPage.deleteFailed")),
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
    onError: toastOnError(t("contactsPage.saveFailed")),
    onSettled: () => invalidateContacts(),
  });

  const thresholdMutation = useMutation({
    mutationFn: ({
      contactId,
      displayName,
      autoApproveThreshold,
    }: {
      contactId: string;
      displayName: string;
      autoApproveThreshold: ContactPayload["autoApproveThreshold"];
    }) =>
      upsertContact(assistantId, {
        id: contactId,
        displayName,
        autoApproveThreshold,
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
    onError: toastOnError(t("contactPermissions.saveFailed")),
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
      toast.success(t("contactsPage.mergeSucceeded"));
    },
    onSettled: () => invalidateContacts(),
  });

  const handleSelect = useCallback(
    (sel: ContactSelection) => {
      setSelection(sel);
      closeDrawer();
      setMergeDialogOpen(false);
      mergeMutation.reset();
    },
    [closeDrawer, mergeMutation],
  );

  const handleOpenMerge = useCallback(() => {
    mergeMutation.reset();
    setMergeDialogOpen(true);
  }, [mergeMutation]);

  const handleCloseMerge = useCallback(() => {
    if (mergeMutation.isPending) {
      return;
    }
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
    if (createMutation.isPending) {
      return;
    }
    createMutation.mutate();
  }, [createMutation]);

  const handleContactSetupChannel = useCallback(
    (type: string) => {
      if (!onStartSetupConversation) {
        return;
      }
      const info = availableChannels.find((ch) => ch.id === type);
      if (!info || isPluginChannel(info)) {
        return;
      }
      const prompt = info.setupMessages.contact;
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
      if (!info || isPluginChannel(info)) {
        return;
      }
      const prompt = info.setupMessages.guardian;
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
    onError: toastOnError(t("contactsPage.verifyFailed")),
  });

  const linkAndVerifyMutation = useMutation({
    mutationFn: (args: { type: string; address: string }) => {
      if (!selectedContact) {
        throw new Error("No contact selected");
      }
      return linkContactChannelAccount(
        assistantId,
        {
          id: selectedContact.id,
          displayName: selectedContact.displayName,
        },
        { type: args.type, address: args.address },
      );
    },
    onSuccess: () => invalidateContacts(),
    onError: toastOnError(t("contactsPage.verifyFailed")),
  });

  const handleVerifyChannel = useCallback(
    (type: string, address?: string) => {
      if (!selectedContact) {
        return;
      }
      const trimmedAddress = address?.trim();
      if (trimmedAddress) {
        linkAndVerifyMutation.mutate({ type, address: trimmedAddress });
        return;
      }
      const channel = selectedContact.channels.find(
        (ch) => ch.type === type && ch.status !== "revoked",
      );
      if (!channel?.address?.trim()) {
        return;
      }
      verifyChannelMutation.mutate({ channelId: channel.id });
    },
    [selectedContact, linkAndVerifyMutation, verifyChannelMutation],
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

  // Without configured Slack credentials the roster can only 503, so the Link
  // action is offered only once Slack is set up. Configuration, not liveness:
  // the roster is an outbound Web API call, so it answers perfectly well while
  // the inbound Socket Mode connection is down, and gating on the connection
  // state would hide a working action during a reconnect.
  const slackReady = channelsController.channels.some(
    (channel) => channel.key === "slack" && channel.configured,
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
    if (!selectedContact) {
      return null;
    }
    let next = selectedContact;
    if (
      updateMutation.isPending &&
      updateMutation.variables?.contactId === selectedContact.id
    ) {
      next = {
        ...next,
        displayName: updateMutation.variables.patch.displayName,
        notes: updateMutation.variables.patch.notes,
      };
    }
    if (
      thresholdMutation.isPending &&
      thresholdMutation.variables?.contactId === selectedContact.id
    ) {
      next = {
        ...next,
        autoApproveThreshold: thresholdMutation.variables.autoApproveThreshold,
      };
    }
    return next;
  }, [
    selectedContact,
    updateMutation.isPending,
    updateMutation.variables,
    thresholdMutation.isPending,
    thresholdMutation.variables,
  ]);

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
    search: contactSearch,
    onSearchChange: setContactSearch,
  };

  return (
    <div
      ref={paneRef}
      className={`flex min-h-0 flex-1 overflow-hidden ${
        hasRoomForList ? "flex-row gap-6" : "flex-col gap-4"
      }`}
    >
      {hasRoomForList ? (
        <aside className="min-h-0 w-[320px] shrink-0 overflow-y-auto self-stretch">
          <ContactsList {...contactsListProps} onSelect={handleSelect} />
        </aside>
      ) : (
        <>
          <div className="flex items-center">
            <SideListTrigger onClick={openDrawer} />
          </div>

          <SideListDrawer
            open={drawerOpen}
            onClose={closeDrawer}
            title={t("contactsPage.title")}
          >
            <ContactsList {...contactsListProps} onSelect={handleSelect} />
          </SideListDrawer>
        </>
      )}

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
              verifyPending={
                verifyChannelMutation.isPending ||
                linkAndVerifyMutation.isPending
              }
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              channelsLoadFailed={channelsLoadFailed}
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
              verifyPending={
                verifyChannelMutation.isPending ||
                linkAndVerifyMutation.isPending
              }
              mergePending={mergeMutation.isPending}
              canMerge={canMerge}
              availableChannels={availableChannels}
              channelsLoadFailed={channelsLoadFailed}
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
              onLinkAccount={slackReady ? handleLinkAccount : undefined}
              pendingAutoApproveThreshold={thresholdMutation.isPending}
              onAutoApproveThresholdChange={(autoApproveThreshold) => {
                thresholdMutation.mutate({
                  contactId: optimisticContact.id,
                  displayName: optimisticContact.displayName,
                  autoApproveThreshold,
                });
              }}
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
                ? t("contactsPage.mergeFailed")
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
        channelLabel={channelTypeLabel("slack")}
        contactName={selectedContact?.displayName ?? ""}
        accounts={slackRosterQuery.data}
        loading={slackRosterQuery.isLoading}
        errorMessage={
          slackRosterQuery.isError
            ? t("contactsPage.rosterLoadFailed")
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
  const { t } = useTranslation("contacts");

  return (
    <div className="flex h-full items-center justify-center py-16">
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {t("contactsPage.emptyBody")}
      </p>
    </div>
  );
}

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
    labels.push(channelTypeLabel(key));
  }
  return labels;
}
