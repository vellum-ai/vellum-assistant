import { Inbox, Search, Send } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Card, cn, Input, SegmentControl } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { InboxEmail, InboxFolder, InboxUsage } from "../types";
import { AssistantInboxHeader } from "./assistant-inbox-header";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailDetail } from "./email-detail";
import { EmailList } from "./email-list";

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
    email.snippet,
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
  onAskToReply?: (email: InboxEmail) => void;
}

/**
 * The inbox when the assistant has an address: masthead, a folder switch,
 * and two cards on the page ground, the list with its search and the
 * reading pane. Below the `md` breakpoint the two cards take turns instead,
 * list first, with a back control on the message. Selection is local;
 * changing folder clears it so a message from Received is never left open
 * over the Sent list. Search is a plain substring match over sender,
 * recipient, subject, and preview, run on the client over the folder
 * already loaded.
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
  onAskToReply,
}: AssistantInboxPageProps) {
  const { t } = useTranslation("assistant-inbox");
  const [folder, setFolder] = useState<InboxFolder>(initialFolder);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId,
  );
  const [query, setQuery] = useState("");
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

  const handleFolderChange = useCallback((next: InboxFolder) => {
    setFolder(next);
    setSelectedId(null);
  }, []);

  const folderItems = useMemo(
    () => [
      {
        value: "inbox" as const,
        label: t("assistantInboxPage.inboxTab"),
        icon: <Inbox className="size-3.5 shrink-0" aria-hidden="true" />,
      },
      {
        value: "sent" as const,
        label: t("assistantInboxPage.sentTab"),
        icon: <Send className="size-3.5 shrink-0" aria-hidden="true" />,
      },
    ],
    [t],
  );

  return (
    <AssistantInboxShell>
      <AssistantInboxHeader
        assistantId={assistantId}
        assistantName={assistantName}
        address={address}
        usage={usage}
      />

      <div className="px-2 pb-3">
        <SegmentControl
          items={folderItems}
          value={folder}
          onChange={handleFolderChange}
          ariaLabel={t("assistantInboxPage.folderAriaLabel")}
          className="w-auto"
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-2 pb-2 md:grid-cols-[minmax(280px,360px)_1fr]">
        {/* The list card owns the search: it filters this folder and
            nothing else, so it sits at the head of the rows it narrows. */}
        <Card
          bordered={false}
          noPadding
          className={cn(CARD_CLASSES, selected && "max-md:hidden")}
        >
          {folderEmails.length > 0 ? (
            <div className="px-3 pt-3 pb-1">
              <Input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("assistantInboxPage.searchPlaceholder")}
                aria-label={t("assistantInboxPage.searchAriaLabel")}
                leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
                fullWidth
              />
            </div>
          ) : null}
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
            />
          )}
        </Card>

        <Card
          bordered={false}
          noPadding
          className={cn(CARD_CLASSES, !selected && "max-md:hidden")}
        >
          {selected ? (
            <EmailDetail
              key={selected.id}
              email={selected}
              assistantName={assistantName}
              onBack={() => setSelectedId(null)}
              onAskToReply={onAskToReply}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-body-small-lighter text-[var(--content-tertiary)]">
              {t("assistantInboxPage.selectPrompt")}
            </div>
          )}
        </Card>
      </div>
    </AssistantInboxShell>
  );
}
