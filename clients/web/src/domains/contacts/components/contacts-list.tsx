import { Loader2, MoreVertical, Pencil, Plus, Search, UserPlus } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";
import { PanelItem } from "@vellumai/design-library/components/panel-item";

import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import type {
    ContactSelection,
    ContactSummary,
} from "@/domains/contacts/types";

interface ContactsListProps {
  loading: boolean;
  guardian: ContactSummary | null;
  assistantName?: string;
  regularContacts: ContactSummary[];
  selection: ContactSelection | null;
  onSelect: (selection: ContactSelection) => void;
  onAddContact: () => void;
  addingContact?: boolean;
}

export function ContactsList({
  loading,
  guardian,
  assistantName,
  regularContacts,
  selection,
  onSelect,
  onAddContact,
  addingContact = false,
}: ContactsListProps) {
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? regularContacts.filter((c) =>
        c.displayName.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : regularContacts;

  return (
    <Card className="h-full">
      <div className="flex h-full min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2
            className="text-title-medium"
            style={{ color: "var(--content-default)" }}
          >
            Entries
          </h2>
          <Button
            type="button"
            variant="ghost"
            iconOnly={addingContact ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            onClick={onAddContact}
            disabled={addingContact}
            aria-label="Add contact"
            tintColor="var(--content-secondary)"
          />
        </div>

        <div className="flex flex-col gap-1">
          {guardian ? (
            <ContactRow
              name={guardian.displayName ? `${guardian.displayName} (You)` : "You"}
              role={guardian.role}
              channelTypes={guardian.channelTypes}
              selected={
                selection?.kind === "contact" && selection.contactId === guardian.id
              }
              onClick={() => onSelect({ kind: "contact", contactId: guardian.id })}
              trailingIcon="pencil"
            />
          ) : null}
          <ContactRow
            name={assistantName?.trim() || "Your Assistant"}
            role="assistant"
            selected={selection?.kind === "assistant"}
            onClick={() => onSelect({ kind: "assistant" })}
            trailingIcon="more"
          />
        </div>

        <div className="border-t" style={{ borderColor: "var(--border-base)" }} />

        {regularContacts.length > 0 ? (
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Contacts"
            leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
            fullWidth
          />
        ) : null}

        {regularContacts.length > 0 ? (
          <div className="flex flex-col gap-1">
            {filtered.map((contact) => (
              <ContactRow
                key={contact.id}
                name={contact.displayName}
                role={contact.role}
                contactType={contact.contactType}
                channelTypes={contact.channelTypes}
                selected={
                  selection?.kind === "contact" && selection.contactId === contact.id
                }
                onClick={() =>
                  onSelect({ kind: "contact", contactId: contact.id })
                }
                trailingIcon="more"
              />
            ))}
            {filtered.length === 0 ? (
              <p
                className="px-3 py-4 text-center text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                No matching contacts
              </p>
            ) : null}
          </div>
        ) : loading ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={onAddContact}
            disabled={addingContact}
            tintColor="var(--primary-base)"
            leftIcon={addingContact ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
          >
            Add Contact
          </Button>
        )}
      </div>
    </Card>
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
}

function ContactRow({
  name,
  role,
  contactType,
  channelTypes,
  selected,
  onClick,
  trailingIcon,
}: ContactRowProps) {
  const channelLabel =
    channelTypes && channelTypes.length > 0
      ? channelTypes.join(" | ")
      : undefined;

  const trailingActionIcon =
    trailingIcon === "pencil" ? (
      <Pencil className="h-3.5 w-3.5" aria-hidden />
    ) : trailingIcon === "more" ? (
      <MoreVertical className="h-3.5 w-3.5" aria-hidden />
    ) : undefined;

  return (
    <PanelItem
      asChild
      active={selected}
      label=""
      trailingAction={trailingActionIcon}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex h-auto w-full items-center gap-2 rounded-[6px] px-[8px] py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-medium-default">{name}</span>
          {channelLabel ? (
            <span
              className="truncate text-body-small-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              {channelLabel}
            </span>
          ) : null}
        </span>
        <span className="shrink-0">
          <ContactTypeBadge role={role} contactType={contactType} />
        </span>
      </button>
    </PanelItem>
  );
}
