import { MoreVertical, Pencil, Plus, Search, UserPlus } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { PanelItem } from "@vellumai/design-library/components/panel-item";

import { Tag } from "@vellumai/design-library/components/tag";
import { cn } from "@vellumai/design-library/utils/cn";

import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import { useTranslation } from "@/i18n";
import type { ContactSummary } from "@/domains/contacts/types";

type ContactsListSurface = "card" | "screen";

interface ContactsListProps {
  loading: boolean;
  guardian: ContactSummary | null;
  regularContacts: ContactSummary[];
  selectedContactId: string | null;
  onSelect: (contactId: string) => void;
  onAddContact: () => void;
  addingContact?: boolean;
  /**
   * Where the list is mounted, which the page decides. `card` sits in the rail
   * or the drawer beside a detail pane. `screen` is the page itself: no card
   * and no heading row, because the top bar carries the title and the add
   * action, and search comes first.
   * @default "card"
   */
  surface?: ContactsListSurface;
  /**
   * The name filter, owned by the page. This list renders in two surfaces
   * that substitute for each other, and switching between them remounts it,
   * so state held here would be dropped when the pane crosses the threshold.
   */
  search: string;
  onSearchChange: (search: string) => void;
}

export function ContactsList({
  loading,
  guardian,
  regularContacts,
  selectedContactId,
  onSelect,
  onAddContact,
  addingContact = false,
  surface = "card",
  search,
  onSearchChange,
}: ContactsListProps) {
  const { t } = useTranslation("contacts");
  const isScreen = surface === "screen";
  const hasContacts = regularContacts.length > 0;
  const filtered = search.trim()
    ? regularContacts.filter((c) =>
        c.displayName.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : regularContacts;

  const searchField = hasContacts ? (
    <Input
      type="text"
      value={search}
      onChange={(e) => onSearchChange(e.target.value)}
      placeholder={t("contactsList.searchPlaceholder")}
      leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
      fullWidth
      className={isScreen ? "h-10" : undefined}
    />
  ) : null;

  const guardianRow = guardian ? (
    <ContactRow
      name={
        guardian.displayName
          ? t("contactsList.youNamed", { name: guardian.displayName })
          : t("contactsList.you")
      }
      role={guardian.role}
      channelTypes={guardian.channelTypes}
      selected={selectedContactId === guardian.id}
      onClick={() => onSelect(guardian.id)}
      trailingIcon={isScreen ? undefined : "pencil"}
      surface={surface}
    />
  ) : null;

  const groupDivider = guardian ? (
    <div className="border-t" style={{ borderColor: "var(--border-base)" }} />
  ) : null;

  const contactRows = hasContacts ? (
    <>
      {filtered.map((contact) => (
        <ContactRow
          key={contact.id}
          name={contact.displayName}
          role={contact.role}
          contactType={contact.contactType}
          channelTypes={contact.channelTypes}
          verified={isScreen ? undefined : contact.verified}
          selected={selectedContactId === contact.id}
          onClick={() => onSelect(contact.id)}
          trailingIcon={isScreen ? undefined : "more"}
          surface={surface}
        />
      ))}
      {filtered.length === 0 ? (
        <p
          className="px-3 py-4 text-center text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {t("contactsList.noMatches")}
        </p>
      ) : null}
    </>
  ) : loading ? null : (
    <Button
      type="button"
      variant="ghost"
      onClick={onAddContact}
      disabled={addingContact}
      tintColor="var(--primary-base)"
      loading={addingContact}
      leftIcon={<UserPlus aria-hidden />}
    >
      {t("contactsList.add")}
    </Button>
  );

  if (isScreen) {
    return (
      <div className="flex flex-col gap-1">
        {searchField}
        {guardianRow}
        {groupDivider}
        <div className="flex flex-col gap-1 pt-2">{contactRows}</div>
      </div>
    );
  }

  return (
    <Card.Root className="flex h-full flex-col overflow-hidden">
      <Card.Body className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2
            className="text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            {t("contactsList.heading")}
          </h2>
          <Button
            type="button"
            variant="ghost"
            loading={addingContact}
            iconOnly={<Plus aria-hidden />}
            onClick={onAddContact}
            disabled={addingContact}
            aria-label={t("contactsList.addAriaLabel")}
            tintColor="var(--content-secondary)"
          />
        </div>

        {guardianRow}
        {groupDivider}

        {searchField}

        {hasContacts ? (
          <div className="min-h-0 flex-1 overflow-y-auto flex flex-col gap-1">
            {contactRows}
          </div>
        ) : (
          contactRows
        )}
      </Card.Body>
    </Card.Root>
  );
}

interface ContactRowProps {
  name: string;
  role: string | null | undefined;
  contactType?: string | null;
  channelTypes?: string[];
  selected: boolean;
  onClick: () => void;
  trailingIcon?: "pencil" | "more";
  /** Renders the Verified/Unverified tag when set; omit to hide (guardian). */
  verified?: boolean;
  surface: ContactsListSurface;
}

function ContactRow({
  name,
  role,
  contactType,
  channelTypes,
  selected,
  onClick,
  trailingIcon,
  verified,
  surface,
}: ContactRowProps) {
  const { t } = useTranslation("contacts");
  const isScreen = surface === "screen";
  const channelLabel =
    channelTypes && channelTypes.length > 0
      ? channelTypes.join(" | ")
      : undefined;

  /* Sits in the row's own trailing cluster: `PanelItem` draws the contents of
     a row it owns, and this row supplies its own button. */
  const trailingActionIcon =
    trailingIcon === "pencil" ? (
      <Pencil
        className="h-3.5 w-3.5 text-[color:var(--content-tertiary)]"
        aria-hidden
      />
    ) : trailingIcon === "more" ? (
      <MoreVertical
        className="h-3.5 w-3.5 text-[color:var(--content-tertiary)]"
        aria-hidden
      />
    ) : undefined;

  /* The screen surface's radius and touch padding go on `PanelItem`, which
     merges them through `cn`; `Slot` only concatenates the child's classes, so
     the same overrides on the button would resolve by stylesheet order. */
  return (
    <PanelItem
      asChild
      active={selected}
      className={isScreen ? "rounded-md max-md:py-2" : undefined}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-auto w-full items-center",
          !isScreen && "gap-2 rounded-[6px] px-[8px] py-2",
          "text-left",
        )}
      >
        <span
          className={cn("flex min-w-0 flex-1 flex-col", isScreen && "gap-0.5")}
        >
          {/* `PanelItem` rests its row at `--content-secondary`; the screen
              surface draws the name at full strength and leaves the channel
              subtitle beneath it muted. */}
          <span
            className={cn(
              "truncate text-body-medium-default",
              isScreen && "text-[var(--content-default)]",
            )}
          >
            {name}
          </span>
          {channelLabel ? (
            <span
              className={cn(
                "truncate",
                isScreen
                  ? "text-label-medium-default"
                  : "text-body-small-default",
              )}
              style={{ color: "var(--content-tertiary)" }}
            >
              {channelLabel}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {verified !== undefined ? (
            <Tag tone={verified ? "positive" : "neutral"}>
              {verified
                ? t("contactsList.verified")
                : t("contactsList.unverified")}
            </Tag>
          ) : null}
          <ContactTypeBadge role={role} contactType={contactType} />
          {trailingActionIcon}
        </span>
      </button>
    </PanelItem>
  );
}
