import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AssistantInboxPage } from "@/domains/assistant-inbox/components/assistant-inbox-page";
import { useAssistantHandleModal } from "@/components/assistant-handle-modal";
import { AssistantInboxSetupCard } from "@/domains/assistant-inbox/components/assistant-inbox-setup-card";
import { AssistantInboxShell } from "@/domains/assistant-inbox/components/assistant-inbox-shell";
import { AssistantInboxUpgradeState } from "@/domains/assistant-inbox/components/assistant-inbox-upgrade-state";
import { useAssistantInboxState } from "@/domains/assistant-inbox/hooks/use-assistant-inbox-state";
import { useInboxMail } from "@/domains/assistant-inbox/hooks/use-inbox-mail";
import type {
  HandleCheckResult,
  InboxEmail,
} from "@/domains/assistant-inbox/types";
import {
  checkAssistantHandleAvailable,
  HANDLE_ERROR_COPY,
} from "@/domains/account/handle";
import {
  assistantsDomainsCreateMutation,
  assistantsEmailAddressesCreateMutation,
  assistantsListQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import {
  channelsReadinessGetQueryKey,
  channelsReadinessRefreshPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { extractErrorMessage } from "@/utils/api-errors";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

function InboxLoading({ label }: { label: string }) {
  return (
    <AssistantInboxShell>
      <div
        role="status"
        className="flex flex-1 items-center justify-center gap-2 text-body-small-lighter text-[var(--content-tertiary)]"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {label}
      </div>
    </AssistantInboxShell>
  );
}

interface MailboxProps {
  assistantId: string;
  platformAssistantId: string;
  assistantName: string;
  address: string;
  addressId: string;
}

/** The mailbox with its reads attached; split out so its hooks run only in the ready state. */
function Mailbox({
  assistantId,
  platformAssistantId,
  assistantName,
  address,
  addressId,
}: MailboxProps) {
  const { t } = useTranslation("assistant-inbox");
  const navigate = useNavigate();
  const mail = useInboxMail(assistantId, platformAssistantId, addressId);

  const askToReply = useCallback(
    (email: InboxEmail) => {
      navigateToNewConversation(navigate, {
        prompt: t("assistantInboxRoute.replyPrompt", {
          id: email.id,
          sender: email.from.name?.trim() || email.from.address,
          subject: email.subject || t("emailListRow.noSubject"),
        }),
      });
    },
    [navigate, t],
  );

  if (mail.isLoading) {
    return <InboxLoading label={t("assistantInboxRoute.loading")} />;
  }

  if (mail.isError) {
    /* A failed read is not an empty folder: say so, and offer the retry,
       rather than draw a mailbox with nothing in it. */
    return (
      <AssistantInboxShell>
        <div className="flex flex-1 items-start justify-center p-6">
          <Notice
            tone="error"
            className="max-w-md"
            actions={
              <Button variant="outlined" size="compact" onClick={mail.retry}>
                {t("assistantInboxRoute.retry")}
              </Button>
            }
          >
            {t("assistantInboxRoute.mailFailed")}
          </Notice>
        </div>
      </AssistantInboxShell>
    );
  }

  return (
    <AssistantInboxPage
      assistantId={assistantId}
      assistantName={assistantName}
      address={address}
      inbox={mail.received}
      sent={mail.sent}
      usage={mail.usage}
      loadDetail={mail.loadDetail}
      onAskToReply={askToReply}
    />
  );
}

/**
 * `/assistant/inbox`. Picks the inbox's state for the active assistant and
 * draws it: the upgrade card, the setup card, or the mailbox. Behind the
 * `assistant-inbox` flag; with it off the route sends the user to chat, so
 * a stale link never opens a surface the rail does not offer. The redirect
 * waits for the flag store to hydrate and the platform session to settle:
 * on a cold load both start out answering "no", and bouncing on those
 * defaults would send a remotely enabled user away from their own inbox.
 */
export function AssistantInboxPageRoute() {
  const { t } = useTranslation("assistant-inbox");
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  const enabled = useClientFeatureFlagStore.use.assistantInbox();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();
  const identityName = useAssistantIdentityStore.use.name();
  const state = useAssistantInboxState(assistantId, identityName ?? "");
  const [settling, setSettling] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  /* The upgrade pitch's "Change handle": the same modal the assistant page
     opens from its @handle line. */
  const handleModal = useAssistantHandleModal(assistantId);

  const createDomain = useMutation(assistantsDomainsCreateMutation());
  const createAddress = useMutation(assistantsEmailAddressesCreateMutation());
  const refreshReadiness = useMutation(channelsReadinessRefreshPostMutation());

  /* The daemon caches whether email is connected for up to its remote-check
     TTL, so after a registration the Channels page could still say "not
     connected" for minutes. The channels page's own registration path posts
     this refresh for that reason, and this second path does the same.
     Keyed on the active id, which is what the daemon readiness query is
     cached under. Best effort: the readiness poll converges on its own. */
  const refreshReadinessMutateAsync = refreshReadiness.mutateAsync;
  const refreshChannelReadiness = useCallback(() => {
    void refreshReadinessMutateAsync({
      path: { assistant_id: assistantId },
      body: { channel: "email" },
    })
      .catch(() => {})
      .finally(() => {
        void queryClient.invalidateQueries({
          queryKey: channelsReadinessGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      });
  }, [assistantId, queryClient, refreshReadinessMutateAsync]);

  /* An advisory probe of a handle typed into the setup card, through the
     same endpoint the profile card's handle editor uses. */
  const platformAssistantId = state.platformAssistantId;
  const checkHandle = useCallback(
    async (handle: string, signal: AbortSignal): Promise<HandleCheckResult> => {
      if (!platformAssistantId) {
        return { available: true };
      }
      const result = await checkAssistantHandleAvailable(
        platformAssistantId,
        handle,
        signal,
      );
      if (result.available) {
        return { available: true };
      }
      return {
        available: false,
        message:
          result.message ??
          (result.code ? HANDLE_ERROR_COPY[result.code] : null) ??
          t("assistantInboxRoute.setupFailed"),
      };
    },
    [platformAssistantId, t],
  );

  const confirmSetup = useCallback(
    async ({ prefix, handle }: { prefix: string; handle: string }) => {
      if (!state.platformAssistantId) {
        return;
      }
      const path = { assistant_id: state.platformAssistantId };
      setSettling(true);
      setSetupError(null);
      try {
        if (state.hasDomain) {
          await createAddress.mutateAsync({
            path,
            body: { username: prefix },
          });
        } else {
          // One call registers the subdomain and the address on it, and the
          // subdomain becomes the assistant's public handle, which is why
          // the card lets the user choose it here.
          await createDomain.mutateAsync({
            path,
            body: { subdomain: handle, email_username: prefix },
          });
          // The handle changed with it; the listing that carries it is stale.
          void queryClient.invalidateQueries({
            queryKey: assistantsListQueryKey(),
          });
        }
        await state.refreshAddresses();
        refreshChannelReadiness();
        toast.success(
          t("assistantInboxRoute.setupSucceeded", {
            address: `${prefix}@${state.hasDomain ? state.handle : handle}.${state.rootDomain}`,
          }),
        );
      } catch (err) {
        captureError(err, { context: "assistant_inbox_setup" });
        // Under the fields rather than in a toast: the refusal is usually
        // about what was typed (a taken handle, a bad prefix), and it should
        // sit beside the thing to fix.
        setSetupError(
          extractErrorMessage(
            err,
            undefined,
            t("assistantInboxRoute.setupFailed"),
          ),
        );
      } finally {
        setSettling(false);
      }
    },
    [
      createAddress,
      createDomain,
      queryClient,
      refreshChannelReadiness,
      state,
      t,
    ],
  );

  if (!flagsHydrated) {
    return <InboxLoading label={t("assistantInboxRoute.loading")} />;
  }
  if (!enabled) {
    return <Navigate to="/" replace />;
  }

  switch (state.status) {
    case "unavailable":
      return <Navigate to="/" replace />;
    case "loading":
      return <InboxLoading label={t("assistantInboxRoute.loading")} />;
    case "upgrade":
      return (
        <>
          <AssistantInboxUpgradeState
            assistantId={assistantId}
            assistantName={state.assistantName}
            handle={state.handle}
            rootDomain={state.rootDomain}
            onEditHandle={handleModal.openModal ?? undefined}
            onUpgrade={() => navigate(routes.plans)}
            onSeePlans={() => navigate(routes.plans)}
          />
          {handleModal.modal}
        </>
      );
    case "setup":
      return (
        <AssistantInboxSetupCard
          assistantId={assistantId}
          handle={state.handle}
          rootDomain={state.rootDomain}
          handleEditable={!state.hasDomain}
          checkHandle={checkHandle}
          error={setupError}
          onDraftChange={() => setSetupError(null)}
          onConfirm={(draft) => void confirmSetup(draft)}
          busy={settling}
        />
      );
    case "ready":
      return (
        <Mailbox
          assistantId={assistantId}
          platformAssistantId={state.platformAssistantId ?? ""}
          assistantName={state.assistantName}
          address={state.address ?? ""}
          addressId={state.addressId ?? ""}
        />
      );
  }
}
