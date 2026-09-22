import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

import { useIntelligenceLayoutSlotsStore } from "@/components/layout/intelligence-layout-slots-store";
import { SideListDrawer, SideListTrigger } from "@/components/side-list-drawer";
import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSideListRoom } from "@/hooks/use-side-list-room";
import { isVerifiedContactChannel } from "@/domains/contacts/channel-linking";
import { channelTypeLabel } from "@/domains/contacts/channel-type-labels";
import { DRAFT_CONTACT_NAME } from "@/domains/contacts/draft-contact";
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
import { useSlackConfigured } from "@/hooks/use-slack-configured";
import { useInviteLinkDialog } from "@/hooks/use-invite-link-dialog";
import { useAccountLink } from "@/domains/contacts/hooks/use-account-link";
import { usePendingContactIds } from "@/domains/contacts/hooks/use-pending-contact-ids";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  PUSHED_FROM_LIST_STATE,
  returnToList,
} from "@/utils/list-detail-navigation";
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
  const queryClient = useQueryClient();
  // Legacy `?setup=<channel>` deep link. The credential forms live only on
  // the Channels tab, so the param is forwarded there (see the redirect
  // below) instead of being consumed via `useSetupChannelParam`.
  const [searchParams] = useSearchParams();
  const rawSetupParam = searchParams.get("setup");
  const setupChannel =
    rawSetupParam && isSetupChannelId(rawSetupParam) ? rawSetupParam : null;

  const { contactId: routeContactId } = useParams<{ contactId: string }>();
  const navigate = useNavigate();
  const { pathname, state: locationState } = useLocation();

  const inviteDialog = useInviteLinkDialog(assistantId);
  const isMobile = useIsMobile();
  const { paneRef, hasRoomForList, drawerOpen, openDrawer, closeDrawer } =
    useSideListRoom();
  // On a phone the list is the page and a contact is a pushed screen. A narrow
  // pane in a desktop window keeps the drawer, since it has no top bar to
  // carry a list-level Back.
  const listIsScreen = isMobile && !hasRoomForList;
  // The list is the whole page, with no detail open over it.
  const listFillsPage = listIsScreen && !routeContactId;
  // The contact is the whole page, with the list a screen behind it.
  const detailFillsPage = listIsScreen && Boolean(routeContactId);
  // Above the inline/drawer branch below, which remounts whichever list
  // surface it swaps to: held inside `ContactsList` the filter would be
  // dropped whenever the pane crosses the threshold, and dragging the chat
  // sidebar is enough to cross it.
  const [contactSearch, setContactSearch] = useState("");
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

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
  // With nothing picked the pane rests on the guardian, but only where a
  // detail sits beside or behind the list. As a screen the list is the whole
  // page and nothing is open.
  const selectedContactId =
    routeContactId ?? (listFillsPage ? null : (guardian?.id ?? null));
  const selectedContact = useMemo<ContactPayload | null>(
    () => contactsData?.find((c) => c.id === selectedContactId) ?? null,
    [contactsData, selectedContactId],
  );

  // The layout's Back returns to the list only while the detail is a pushed
  // screen, which the pane's own width decides.
  const setDetailIsScreen =
    useIntelligenceLayoutSlotsStore.use.setDetailIsScreen();

  // A push is marked so Back pops to the list, and only a pick made while the
  // list is the page has a list behind it. Every other pick lands on a detail
  // already open (a row beside the rail, a merge survivor), which is a move
  // within one page rather than a step to walk back through, so it replaces
  // that entry and carries its state: one pushed from the list keeps its
  // marker, a deep-linked one stays unmarked.
  const selectContact = useCallback(
    (contactId: string) => {
      if (contactId === routeContactId) {
        return;
      }
      if (listFillsPage) {
        // Reported with the navigation so the layout's Back lands in the same
        // commit as the pushed screen: a Back a commit behind aims at the
        // assistant overview over an open contact. The layout ignores the
        // flag on the list path, so a navigation that never lands cannot
        // strand it.
        setDetailIsScreen(true);
      }
      void navigate(
        routes.contacts.detail(contactId),
        listFillsPage
          ? { state: PUSHED_FROM_LIST_STATE }
          : { replace: true, state: locationState },
      );
    },
    [navigate, listFillsPage, routeContactId, locationState, setDetailIsScreen],
  );

  // The page's own ways out of an open contact, over the same `returnToList`
  // the layout's top-bar Back uses, so a pushed entry always pops and a
  // deep-linked one always replaces.
  const backToList = useCallback(() => {
    returnToList(navigate, locationState, routes.contacts.root);
  }, [navigate, locationState]);

  // A contact that fills the page is the back-swipe owner, so `ChatLayout`
  // yields the left edge to it rather than opening the nav drawer. The list
  // screen and both pane modes keep that drawer gesture. The section is what
  // the swipe drags: on a phone it is the whole visible page. No prefetch:
  // list and detail resolve to one lazy chunk, already loaded here.
  const swipeContainerRef = useRef<HTMLElement>(null);
  useEdgeSwipeBack({
    containerRef: swipeContainerRef,
    onBack: backToList,
    enabled: detailFillsPage,
    navKey: pathname,
  });

  // Positive evidence that this list is the whole list. `fetchStatus` rather
  // than `isFetching` because TanStack's default `networkMode` pauses an
  // offline request, which reads as neither fetching nor failed.
  const contactsListSettled =
    contactsQuery.isSuccess && contactsQuery.fetchStatus === "idle";

  // An id no contact carries keeps its URL until the list settles: one that
  // arrives later (an invalidation, a refetch, a reconnect) resolves the link
  // on its own.
  const resolvingRouteContact =
    Boolean(routeContactId) && !selectedContact && !contactsListSettled;

  // One observer reports only its newest mutation, so each page-global
  // mutation's in-flight contacts are held by id: a second request must not
  // speak for the one still open before it.
  const pendingDeletes = usePendingContactIds();
  const pendingSaves = usePendingContactIds();
  const pendingThresholds = usePendingContactIds();

  const mergeCandidates = useMemo<ContactPayload[]>(() => {
    if (!contactsData || !selectedContact) {
      return [];
    }
    // A contact whose DELETE is open has left the list, so offering it as a
    // donor would race that request.
    return contactsData.filter(
      (c) =>
        c.id !== selectedContact.id &&
        c.role !== "guardian" &&
        !pendingDeletes.ids.has(c.id),
    );
  }, [contactsData, selectedContact, pendingDeletes.ids]);
  const canMerge = mergeCandidates.length > 0;

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const invalidateContacts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: contactsQueryKey }),
    [queryClient, contactsQueryKey],
  );

  // A mutation's own callbacks run from the request, not from this component,
  // so a response that lands after the page is left still reaches them. The
  // cache writes belong to the data either way; a navigation belongs to the
  // page that asked for it, and would otherwise drag the user back to Contacts
  // (under whichever assistant they switched to). Every post-success move
  // below is gated on this.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      if (mountedRef.current) {
        selectContact(contact.id);
      }
    },
    onError: toastOnError(t("contactsPage.createFailed")),
    onSettled: () => invalidateContacts(),
  });

  // Fresh options reach only the newest mutation, so an older delete's
  // callbacks keep the selection they were built with. The ref carries the
  // live one, written at commit so a response cannot read a stale value.
  const selectedContactIdRef = useRef(selectedContactId);
  useLayoutEffect(() => {
    selectedContactIdRef.current = selectedContactId;
  }, [selectedContactId]);

  const deleteMutation = useMutation({
    mutationFn: (contactId: string) =>
      gatewayDeleteContact(assistantId, contactId),
    onMutate: (contactId) => {
      pendingDeletes.add(contactId);
    },
    onSuccess: (_data, contactId) => {
      contactsGetSetQueryData(queryClient, contactsPathOpts, (prev) =>
        prev
          ? {
              ...prev,
              contacts: prev.contacts.filter((c) => c.id !== contactId),
            }
          : undefined,
      );
      // Another contact may be open by now, holding edits of its own.
      if (mountedRef.current && selectedContactIdRef.current === contactId) {
        backToList();
      }
    },
    onError: toastOnError(t("contactsPage.deleteFailed")),
    onSettled: (_data, _error, contactId) => {
      pendingDeletes.remove(contactId);
      return invalidateContacts();
    },
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
    onMutate: ({ contactId }) => {
      pendingSaves.add(contactId);
    },
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
    onSettled: (_data, _error, { contactId }) => {
      pendingSaves.remove(contactId);
      return invalidateContacts();
    },
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
    onMutate: ({ contactId }) => {
      pendingThresholds.add(contactId);
    },
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
    onSettled: (_data, _error, { contactId }) => {
      pendingThresholds.remove(contactId);
      return invalidateContacts();
    },
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
        if (mountedRef.current) {
          selectContact(mergedContact.id);
        }
      }
      setMergeDialogOpen(false);
      toast.success(t("contactsPage.mergeSucceeded"));
    },
    onSettled: () => invalidateContacts(),
  });

  // The mutation object is new every render; its bound methods are not, so
  // the callbacks below keep their identity across renders.
  const resetMerge = mergeMutation.reset;

  const handleSelect = useCallback(
    (contactId: string) => {
      selectContact(contactId);
      closeDrawer();
      setMergeDialogOpen(false);
      resetMerge();
    },
    [selectContact, closeDrawer, resetMerge],
  );

  const handleOpenMerge = useCallback(() => {
    resetMerge();
    setMergeDialogOpen(true);
  }, [resetMerge]);

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

  const createContact = createMutation.mutate;
  const createPending = createMutation.isPending;
  const handleAddContact = useCallback(() => {
    if (createPending) {
      return;
    }
    createContact();
  }, [createContact, createPending]);

  // As a screen the list has no heading row of its own, so the add action
  // rides the layout's mobile top bar. Everywhere else the card's own plus
  // carries it.
  const setHeaderTrailing =
    useIntelligenceLayoutSlotsStore.use.setHeaderTrailing();
  useEffect(() => {
    if (!listFillsPage) {
      setHeaderTrailing(null);
      return;
    }
    setHeaderTrailing(
      <Button
        shape="pill"
        variant="ghost"
        iconOnly={<Plus aria-hidden />}
        aria-label={t("contactsList.addAriaLabel")}
        tooltip={t("contactsList.addAriaLabel")}
        className="max-md:bg-[var(--surface-active)]"
        loading={createPending}
        disabled={createPending}
        onClick={handleAddContact}
      />,
    );
    return () => {
      setHeaderTrailing(null);
    };
  }, [createPending, handleAddContact, listFillsPage, setHeaderTrailing, t]);

  // Layout effect, not passive: the layout above reads this flag, so it is
  // published in the commit that measured the pane rather than a phase later.
  useLayoutEffect(() => {
    setDetailIsScreen(detailFillsPage);
    return () => {
      setDetailIsScreen(false);
    };
  }, [detailFillsPage, setDetailIsScreen]);

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
  // action is offered only once Slack is set up.
  const slackReady = useSlackConfigured(assistantId);

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

  // The overlay reads the observer because it needs the values a request
  // carries, which only the newest call reports. Whether a contact has a
  // request open at all is the pending-id sets' answer, below.
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

  // Each flag belongs to the open contact alone: saving one contact must not
  // freeze the form of another, and must stay set while a later save on a
  // different contact is the one the observer describes.
  const savePending =
    selectedContactId !== null && pendingSaves.ids.has(selectedContactId);
  const thresholdPending =
    selectedContactId !== null && pendingThresholds.ids.has(selectedContactId);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Old builds' mobile chat handoff (and saved links) deep-link channel setup
  // to this page. The forms they target live on the Channels tab, so the link
  // is forwarded there.
  if (setupChannel) {
    return <Navigate to={`${routes.channels}?setup=${setupChannel}`} replace />;
  }

  const contactsListProps = {
    loading: contactsQuery.isLoading,
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
      .filter((c) => !pendingDeletes.ids.has(c.id))
      .map((c) => ({
        id: c.id,
        displayName: c.displayName,
        role: c.role,
        contactType: c.contactType,
        channelTypes: channelTypeLabels(c.channels, a2aChannel),
        verified: isVerifiedContact(c.channels),
      })),
    selectedContactId,
    onSelect: handleSelect,
    onAddContact: handleAddContact,
    addingContact: createPending,
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
          <ContactsList {...contactsListProps} />
        </aside>
      ) : listIsScreen ? null : (
        <>
          <div className="flex items-center">
            <SideListTrigger onClick={openDrawer} />
          </div>

          <SideListDrawer
            open={drawerOpen}
            onClose={closeDrawer}
            title={t("contactsPage.title")}
          >
            <ContactsList {...contactsListProps} />
          </SideListDrawer>
        </>
      )}

      {/* One slot in every mode, so an open detail keeps its form state when
          the pane crosses the threshold. */}
      <section
        ref={swipeContainerRef}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        {/* The spinner comes first: as the page the list renders nothing at
            all during a cold load, so the branch below would leave a bare
            screen under the top bar. */}
        {contactsQuery.isLoading || resolvingRouteContact ? (
          <ContactsPaneSpinner />
        ) : listFillsPage ? (
          <ContactsList {...contactsListProps} surface="screen" />
        ) : optimisticContact ? (
          optimisticContact.role === "guardian" ? (
            <GuardianDetailView
              contact={optimisticContact}
              savePending={savePending}
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
              savePending={savePending}
              // The list stays reachable during a delete, so the freeze
              // belongs to the contact being deleted, not whichever is open.
              deletePending={pendingDeletes.ids.has(optimisticContact.id)}
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
              pendingAutoApproveThreshold={thresholdPending}
              onAutoApproveThresholdChange={(autoApproveThreshold) => {
                thresholdMutation.mutate({
                  contactId: optimisticContact.id,
                  displayName: optimisticContact.displayName,
                  autoApproveThreshold,
                });
              }}
            />
          )
        ) : routeContactId ? (
          <ContactsPaneMessage text={t("contactsPage.notFoundBody")} />
        ) : (
          <ContactsPaneMessage text={t("contactsPage.emptyBody")} />
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

/** The pane's resting copy: nothing picked, or a URL naming no contact. */
function ContactsPaneMessage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {text}
      </p>
    </div>
  );
}

function ContactsPaneSpinner() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
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
