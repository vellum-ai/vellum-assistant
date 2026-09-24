import { Inbox, Search, Send } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  Card,
  cn,
  ConfirmDialog,
  Input,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
} from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type {
  EmailDetailLoader,
  InboxEmail,
  InboxFolder,
  InboxUsage,
} from "../types";
import { AssistantInboxHeader } from "./assistant-inbox-header";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailDetail, type EmailDetailState } from "./email-detail";
import { EmailList } from "./email-list";
import { EmailSelectionBar } from "./email-selection-bar";
import { ReadingPaneEmptyState } from "./reading-pane-empty-state";

/** The same rounded, unbordered surface the sidebar's section cards use. */
const CARD_CLASSES =
  "flex min-h-0 flex-col overflow-hidden rounded-[16px] bg-[var(--surface-lift)]";

interface FolderEmptyStateProps {
  folder: InboxFolder;
  address: string;
  /** A search is active, so the folder is not empty, just filtered to nothing. */
  searching: boolean;
}

function FolderEmptyState({
  folder,
  address,
  searching,
}: FolderEmptyStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const Icon = searching ? Search : folder === "inbox" ? Inbox : Send;
  const title = searching
    ? t("assistantInboxPage.searchEmptyTitle")
    : folder === "inbox"
      ? t("assistantInboxPage.inboxEmptyTitle")
      : t("assistantInboxPage.sentEmptyTitle");
  const body = searching
    ? t("assistantInboxPage.searchEmptyBody")
    : folder === "inbox"
      ? t("assistantInboxPage.inboxEmptyBody", { address })
      : t("assistantInboxPage.sentEmptyBody");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--surface-active)]">
        <Icon
          className="size-5 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
      </span>
      <p className="text-body-medium-default text-[var(--content-default)]">
        {title}
      </p>
      <p className="max-w-xs text-body-small-lighter text-[var(--content-tertiary)]">
        {body}
      </p>
    </div>
  );
}

/** Case-insensitive match over the fields a person remembers a mail by. */
function matchesQuery(email: InboxEmail, query: string): boolean {
  const haystack = [
    email.subject,
    email.snippet ?? "",
    email.from.name ?? "",
    email.from.address,
    ...email.to.flatMap((to) => [to.name ?? "", to.address]),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

export interface AssistantInboxPageProps {
  assistantId: string;
  assistantName: string;
  address: string;
  inbox: InboxEmail[];
  sent: InboxEmail[];
  usage?: InboxUsage;
  /** Injected so fixtures render stable relative times. Defaults to the clock. */
  now?: Date;
  /** The folder to open on. Defaults to the inbox. */
  initialFolder?: InboxFolder;
  /** A message to open on, for a deep link or a story. Must be in `initialFolder`. */
  initialSelectedId?: string | null;
  /**
   * Fetches a message's body and attachments when it is opened, for rows
   * that came without them. A row that already carries a body (a fixture,
   * a prefetched message) is drawn from what it has and never fetched.
   */
  loadDetail?: EmailDetailLoader;
  onAskToReply?: (email: InboxEmail) => void;
  /** Messages to open checked, for a story or a test. */
  initialCheckedIds?: string[];
  /**
   * Starts a chat with the checked messages staged in its composer. Without
   * it the selection bar offers no chat action.
   */
  onStartChat?: (emails: InboxEmail[]) => void;
  /**
   * Removes the checked messages from the inbox, once the user has
   * confirmed. Without it the selection bar offers no delete action.
   */
  onDeleteEmails?: (emails: InboxEmail[]) => void;
}

/**
 * The inbox when the assistant has an address: masthead, a folder switch,
 * and two cards on the page ground, the list with its search and the
 * reading pane. Below the `md` breakpoint the two cards take turns instead,
 * list first, with a back control on the message. The open message is
 * local; changing folder clears it so a message from Received is never left
 * open over the Sent list. Checked messages are kept across the folder
 * switch, since a chat may want mail from both, and the bar that rises over
 * the cards while any are checked is where the selection is acted on.
 * Search is a plain substring match over sender, recipient, subject, and
 * preview, run on the client over the folder already loaded.
 */
export function AssistantInboxPage({
  assistantId,
  assistantName,
  address,
  inbox,
  sent,
  usage,
  now,
  initialFolder = "inbox",
  initialSelectedId = null,
  loadDetail,
  onAskToReply,
  initialCheckedIds,
  onStartChat,
  onDeleteEmails,
}: AssistantInboxPageProps) {
  const { t } = useTranslation("assistant-inbox");
  const [folder, setFolder] = useState<InboxFolder>(initialFolder);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const [query, setQuery] = useState("");
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialCheckedIds),
  );
  /* The messages awaiting the user's confirmation to delete, or none. */
  const [pendingDelete, setPendingDelete] = useState<InboxEmail[] | null>(null);
  const selectable = onStartChat !== undefined || onDeleteEmails !== undefined;
  const clock = useMemo(() => now ?? new Date(), [now]);

  const trimmedQuery = query.trim().toLowerCase();
  const folderEmails = folder === "inbox" ? inbox : sent;
  const emails = useMemo(
    () =>
      trimmedQuery
        ? folderEmails.filter((email) => matchesQuery(email, trimmedQuery))
        : folderEmails,
    [folderEmails, trimmedQuery],
  );
  const selected = emails.find((email) => email.id === selectedId) ?? null;

  /* The body arrives with the row or with a fetch, never both: a row that
     carries one is drawn as is, and only a row without one asks the loader.
     Keyed on the message so switching messages never shows the last body
     under the next subject. */
  const needsFetch = !!selected && selected.body === undefined && !!loadDetail;
  const detailQuery = useQuery({
    queryKey: ["assistant-inbox", "detail", selected?.id ?? ""],
    queryFn: () => loadDetail!(selected!),
    enabled: needsFetch,
    staleTime: 5 * 60_000,
  });
  const detail: EmailDetailState | null = !selected
    ? null
    : selected.body !== undefined
      ? {
          status: "ready",
          body: selected.body,
          attachments: selected.attachments ?? [],
        }
      : detailQuery.data
        ? { status: "ready", ...detailQuery.data }
        : detailQuery.isError
          ? { status: "error" }
          : { status: "loading" };

  const handleFolderChange = useCallback((next: InboxFolder) => {
    setFolder(next);
    setSelectedId(null);
  }, []);

  /* Checked messages resolve against both folders, so a row checked in
     Received stays counted while the Sent list is showing. */
  const checkedEmails = useMemo(
    () => [...inbox, ...sent].filter((email) => checkedIds.has(email.id)),
    [inbox, sent, checkedIds],
  );
  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const clearChecked = useCallback(() => setCheckedIds(new Set()), []);

  const startChat = useCallback(
    (emails: InboxEmail[]) => {
      onStartChat?.(emails);
      setCheckedIds(new Set());
    },
    [onStartChat],
  );
  const confirmDelete = useCallback(() => {
    if (!pendingDelete) {
      return;
    }
    onDeleteEmails?.(pendingDelete);
    const removed = new Set(pendingDelete.map((email) => email.id));
    setCheckedIds(
      (previous) => new Set([...previous].filter((id) => !removed.has(id))),
    );
    setSelectedId((current) =>
      current !== null && removed.has(current) ? null : current,
    );
    setPendingDelete(null);
  }, [onDeleteEmails, pendingDelete]);

  return (
    <AssistantInboxShell>
      <AssistantInboxHeader
        assistantId={assistantId}
        assistantName={assistantName}
        address={address}
        usage={usage}
      />

      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-4 px-2 pb-2 pt-1 md:grid-cols-[minmax(280px,360px)_1fr]">
        {/* The list card owns the folder switch and the search: both are
            about the rows under them and nothing else. */}
        <Card
          bordered={false}
          noPadding
          className={cn(CARD_CLASSES, selected && "max-md:hidden")}
        >
          <TabsRoot
            value={folder}
            onValueChange={(next) => handleFolderChange(next as InboxFolder)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex flex-col gap-4 px-4 pt-4 pb-1">
              <TabsList
                aria-label={t("assistantInboxPage.folderAriaLabel")}
                className="border-b-2 border-[var(--border-hover)]"
              >
                <TabsTrigger value="inbox" className="-mb-0.5">
                  {t("assistantInboxPage.inboxTab")}
                </TabsTrigger>
                <TabsTrigger value="sent" className="-mb-0.5">
                  {t("assistantInboxPage.sentTab")}
                </TabsTrigger>
              </TabsList>
              {folderEmails.length > 0 ? (
                <Input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("assistantInboxPage.searchPlaceholder")}
                  aria-label={t("assistantInboxPage.searchAriaLabel")}
                  leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
                  fullWidth
                  /* Filled rather than outlined, as the design draws it. */
                  className="rounded-lg border-transparent bg-[var(--surface-active)] focus-visible:border-[var(--border-active)]"
                />
              ) : null}
            </div>
            <TabsPanel
              value={folder}
              className="flex min-h-0 flex-1 flex-col outline-none"
            >
              {emails.length === 0 ? (
                <FolderEmptyState
                  folder={folder}
                  address={address}
                  searching={trimmedQuery.length > 0}
                />
              ) : (
                <EmailList
                  emails={emails}
                  selectedId={selectedId}
                  now={clock}
                  onSelect={setSelectedId}
                  checkedIds={selectable ? checkedIds : undefined}
                  onToggleChecked={selectable ? toggleChecked : undefined}
                />
              )}
            </TabsPanel>
          </TabsRoot>
        </Card>

        <Card
          bordered={false}
          noPadding
          className={cn(CARD_CLASSES, !selected && "max-md:hidden")}
        >
          {selected && detail ? (
            <EmailDetail
              key={selected.id}
              email={selected}
              detail={detail}
              assistantName={assistantName}
              onBack={() => setSelectedId(null)}
              onAskToReply={onAskToReply}
            />
          ) : (
            <ReadingPaneEmptyState />
          )}
        </Card>

        {/* Rises over the foot of both cards while anything is checked. The
            wrapper lets clicks through to the cards around the bar. */}
        {selectable ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
            <EmailSelectionBar
              emails={checkedEmails}
              onClear={clearChecked}
              onStartChat={onStartChat ? startChat : undefined}
              onDelete={onDeleteEmails ? setPendingDelete : undefined}
            />
          </div>
        ) : null}
      </div>

      {onDeleteEmails ? (
        <ConfirmDialog
          open={pendingDelete !== null}
          destructive
          title={t("deleteEmailsDialog.title", {
            count: pendingDelete?.length ?? 0,
          })}
          message={t("deleteEmailsDialog.message", {
            count: pendingDelete?.length ?? 0,
          })}
          confirmLabel={t("deleteEmailsDialog.confirm")}
          cancelLabel={t("deleteEmailsDialog.cancel")}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </AssistantInboxShell>
  );
}
