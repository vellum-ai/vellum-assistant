import { ArrowRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

import type { RosterAccount } from "@/domains/contacts/channel-linking";

/** Name/@handle search over the roster (leading `@` optional). */
export function filterRosterAccounts(
  accounts: RosterAccount[],
  search: string,
): RosterAccount[] {
  const query = search.trim().toLowerCase().replace(/^@/, "");
  if (query === "") {
    return accounts;
  }
  return accounts.filter(
    (account) =>
      account.displayName.toLowerCase().includes(query) ||
      account.username.toLowerCase().includes(query),
  );
}

function initials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.[0] ?? "?";
  const last = tokens.length > 1 ? (tokens[tokens.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export interface LinkAccountDialogProps {
  open: boolean;
  /** Channel display label for the dialog copy (e.g. "Slack"). */
  channelLabel: string;
  /** Display name of the contact being linked, for the dialog copy. */
  contactName: string;
  accounts?: RosterAccount[];
  loading?: boolean;
  /** Roster fetch or link failure message shown inline. */
  errorMessage?: string | null;
  /** Roster account a link call is currently in flight for. */
  pendingAccountId?: string | null;
  onPick: (account: RosterAccount) => void;
  onClose: () => void;
  /** Fallback to the existing invite (handshake) flow. */
  onInviteInstead?: () => void;
}

/**
 * Roster picker behind a linkable channel row's "Link account" action.
 * Picking an account marks it guardian-linked — the guardian vouches for
 * the identity, no handshake needed. Channel-agnostic: the adapter supplies
 * the roster (see `domains/contacts/channel-linking.ts`).
 */
export function LinkAccountDialog({
  open,
  channelLabel,
  contactName,
  accounts,
  loading,
  errorMessage,
  pendingAccountId,
  onPick,
  onClose,
  onInviteInstead,
}: LinkAccountDialogProps) {
  const [search, setSearch] = useState("");

  // A fresh open starts with a clean search, not the previous session's.
  useEffect(() => {
    if (open) {
      setSearch("");
    }
  }, [open]);

  const visibleAccounts = useMemo(
    () => filterRosterAccounts(accounts ?? [], search),
    [accounts, search],
  );

  const linking = pendingAccountId != null;

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Link {channelLabel} account</Modal.Title>
          <Modal.Description>
            Search your {channelLabel} workspace and pick{" "}
            <span className="text-[color:var(--content-default)]">
              {contactName}
            </span>
            &rsquo;s account.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-3">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or @handle"
            aria-label={`Search ${channelLabel} workspace accounts`}
            leftIcon={<Search className="h-4 w-4" />}
            fullWidth
          />
          {errorMessage ? (
            <p className="text-body-small-default text-[color:var(--content-negative)]">
              {errorMessage}
            </p>
          ) : null}
          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <p className="py-4 text-center text-body-small-default text-[color:var(--content-tertiary)]">
                Loading workspace members…
              </p>
            ) : visibleAccounts.length === 0 ? (
              <p className="py-4 text-center text-body-small-default text-[color:var(--content-tertiary)]">
                {(accounts?.length ?? 0) === 0
                  ? "No workspace members found."
                  : "No members match."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {visibleAccounts.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => onPick(account)}
                      disabled={linking}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--surface-overlay)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {account.imageUrl ? (
                        <img
                          src={account.imageUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded-full"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--tag-bg-neutral)] text-body-small-emphasised text-[color:var(--content-secondary)]"
                        >
                          {initials(account.displayName)}
                        </span>
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-body-medium-default text-[color:var(--content-default)]">
                          {account.displayName}
                        </span>
                        <span className="truncate text-body-small-default text-[color:var(--content-tertiary)]">
                          @{account.username}
                        </span>
                      </span>
                      {pendingAccountId === account.id ? (
                        <span className="ml-auto shrink-0 text-body-small-default text-[color:var(--content-tertiary)]">
                          Linking…
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer className="items-center justify-between gap-3 border-t border-[var(--border-base)]">
          <p className="text-body-small-default text-[color:var(--content-tertiary)]">
            Picking marks this account as{" "}
            <span className="text-[color:var(--content-secondary)]">
              guardian-linked
            </span>{" "}
            — you vouch for the identity, no handshake needed.
          </p>
          {onInviteInstead ? (
            <Button
              variant="link"
              className="shrink-0"
              onClick={onInviteInstead}
              disabled={linking}
            >
              Or send an invite instead
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
