/**
 * Controller for a channel's "Link account" flow on the contact detail page:
 * owns the picker dialog state and the link mutation (gateway upsert of the
 * channel + manual verify).
 *
 * Channel-agnostic — the adapter's roster query stays with the page (queries
 * live at the page layer), gated on `dialogOpen` so the roster is only
 * fetched while the picker is open. See `domains/contacts/channel-linking.ts`
 * for the adapter seam.
 */
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { toast } from "@vellumai/design-library/components/toast";

import type { RosterAccount } from "@/domains/contacts/channel-linking";
import { linkContactChannelAccount } from "@/domains/contacts/contacts-gateway";

export interface AccountLinkController {
  channelType: string;
  dialogOpen: boolean;
  open: () => void;
  close: () => void;
  /** Link failure message for inline display, if any. */
  linkErrorMessage: string | null;
  /** Roster account a link call is in flight for, if any. */
  pendingAccountId: string | null;
  pick: (account: RosterAccount) => void;
}

export function useAccountLink({
  assistantId,
  channelType,
  contact,
  onLinked,
}: {
  assistantId: string;
  channelType: string;
  contact: { id: string; displayName: string } | null;
  onLinked: () => void;
}): AccountLinkController {
  const [dialogOpen, setDialogOpen] = useState(false);

  const linkMutation = useMutation({
    mutationFn: (args: {
      contact: { id: string; displayName: string };
      account: RosterAccount;
    }) =>
      linkContactChannelAccount(assistantId, args.contact, {
        type: channelType,
        address: args.account.id,
      }),
    onSuccess: (_contact, args) => {
      setDialogOpen(false);
      toast.success(`Linked as @${args.account.username}`);
      onLinked();
    },
  });

  const open = useCallback(() => {
    linkMutation.reset();
    setDialogOpen(true);
  }, [linkMutation]);

  const close = useCallback(() => {
    if (linkMutation.isPending) {
      return;
    }
    linkMutation.reset();
    setDialogOpen(false);
  }, [linkMutation]);

  const pick = useCallback(
    (account: RosterAccount) => {
      if (!contact || linkMutation.isPending) {
        return;
      }
      linkMutation.mutate({ contact, account });
    },
    [contact, linkMutation],
  );

  const linkErrorMessage =
    linkMutation.error instanceof Error
      ? linkMutation.error.message
      : linkMutation.error
        ? "Failed to link account"
        : null;

  return {
    channelType,
    dialogOpen,
    open,
    close,
    linkErrorMessage,
    pendingAccountId: linkMutation.isPending
      ? linkMutation.variables.account.id
      : null,
    pick,
  };
}
