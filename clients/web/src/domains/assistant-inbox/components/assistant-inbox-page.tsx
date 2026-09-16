import { Inbox, Search, Send } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn, Input, Tabs } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { InboxEmail, InboxFolder, InboxUsage } from "../types";
import { AssistantInboxHeader } from "./assistant-inbox-header";
import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailDetail } from "./email-detail";
import { EmailList } from "./email-list";

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
 * The inbox when the assistant has an address: masthead, a folder tab row
 * with a search beside it, and a list beside a reading pane. Below the `md`
 * breakpoint the two panes take turns instead, list first, with a back
 * control on the message. Selection is local; changing folder clears it so
 * a message from Inbox is never left open over the Sent list. Search is a
 * plain substring match over sender, recipient, subject, and preview, run
 * on the client over the folder already loaded.
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

  const handleFolderChange = useCallback((next: string) => {
    if (next === "inbox" || next === "sent") {
      setFolder(next);
      setSelectedId(null);
    }
  }, []);

  return (
    <AssistantInboxShell>
      <AssistantInboxHeader
        assistantId={assistantId}
        assistantName={assistantName}
        address={address}
        usage={usage}
      />

      <Tabs.Root value={folder} onValueChange={handleFolderChange}>
        {/* The tab list's own rule is the divider between the masthead and
            the mail; the search rides on the same line, on the far edge. */}
        <Tabs.List
          className="px-6"
          aria-label={t("assistantInboxPage.folderAriaLabel")}
        >
          <Tabs.Trigger value="inbox">
            {t("assistantInboxPage.inboxTab")}
          </Tabs.Trigger>
          <Tabs.Trigger value="sent">
            {t("assistantInboxPage.sentTab")}
          </Tabs.Trigger>
          <div className="ml-auto w-full max-w-[260px] pb-1.5">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("assistantInboxPage.searchPlaceholder")}
              aria-label={t("assistantInboxPage.searchAriaLabel")}
              leftIcon={<Search aria-hidden="true" />}
            />
          </div>
        </Tabs.List>
      </Tabs.Root>

      {emails.length === 0 ? (
        <FolderEmptyState
          folder={folder}
          address={address}
          searching={trimmedQuery.length > 0}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,360px)_1fr]">
          <EmailList
            emails={emails}
            selectedId={selectedId}
            now={clock}
            onSelect={setSelectedId}
            className={cn(
              "md:border-r md:border-[var(--border-subtle)]",
              selected && "max-md:hidden",
            )}
          />
          {selected ? (
            <EmailDetail
              key={selected.id}
              email={selected}
              assistantName={assistantName}
              onBack={() => setSelectedId(null)}
              onAskToReply={onAskToReply}
            />
          ) : (
            <div className="hidden items-center justify-center p-8 text-body-small-lighter text-[var(--content-tertiary)] md:flex">
              {t("assistantInboxPage.selectPrompt")}
            </div>
          )}
        </div>
      )}
    </AssistantInboxShell>
  );
}
