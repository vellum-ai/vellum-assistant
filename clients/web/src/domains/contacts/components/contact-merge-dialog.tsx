import { ArrowLeft, GitMerge, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ContactPayload } from "@/domains/contacts/types";

export interface ContactMergeDialogProps {
  open: boolean;
  survivor: ContactPayload;
  candidates: ContactPayload[];
  pending: boolean;
  errorMessage?: string | null;
  onMerge: (donorId: string) => void;
  onClose: () => void;
}

export function ContactMergeDialog(props: ContactMergeDialogProps) {
  return (
    <ContactMergeDialogInner
      key={`${props.survivor.id}:${props.open ? "open" : "closed"}`}
      {...props}
    />
  );
}

function ContactMergeDialogInner({
  open,
  survivor,
  candidates,
  pending,
  errorMessage,
  onMerge,
  onClose,
}: ContactMergeDialogProps) {
  const [search, setSearch] = useState("");
  const [donorId, setDonorId] = useState<string | null>(null);

  useEffect(() => {
    if (donorId && !candidates.some((c) => c.id === donorId)) {
      setDonorId(null);
    }
  }, [candidates, donorId]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      c.displayName.toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const donor = donorId
    ? candidates.find((c) => c.id === donorId) ?? null
    : null;

  const survivorLabel = formatSurvivorName(survivor);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title icon={GitMerge}>
            {donor
              ? `Merge "${donor.displayName}" into ${survivorLabel}?`
              : `Merge another contact into ${survivorLabel}`}
          </Modal.Title>
          <Modal.Description>
            {donor
              ? "Channels and notes from the merged contact will move over. The merged contact will be deleted."
              : "The contact you pick will be deleted. Its channels and notes will be added to this one."}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-3">
          {donor ? (
            <MergeSummary survivor={survivor} donor={donor} />
          ) : candidates.length === 0 ? (
            <MergeEmptyState />
          ) : (
            <CandidateList
              search={search}
              onSearch={setSearch}
              candidates={filteredCandidates}
              onPick={setDonorId}
            />
          )}
          {errorMessage ? (
            <Typography
              as="p"
              variant="body-small-default"
              className="text-(--system-negative-strong)"
              role="alert"
            >
              {errorMessage}
            </Typography>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          {donor ? (
            <>
              <Button
                variant="outlined"
                onClick={() => setDonorId(null)}
                disabled={pending}
                leftIcon={<ArrowLeft aria-hidden />}
              >
                Back
              </Button>
              <Button
                variant="danger"
                onClick={() => onMerge(donor.id)}
                disabled={pending}
              >
                {pending ? "Merging…" : "Merge"}
              </Button>
            </>
          ) : (
            <Button variant="outlined" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

interface CandidateListProps {
  search: string;
  onSearch: (next: string) => void;
  candidates: ContactPayload[];
  onPick: (id: string) => void;
}

function CandidateList({
  search,
  onSearch,
  candidates,
  onPick,
}: CandidateListProps) {
  return (
    <>
      <Input
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search contacts"
        leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
        fullWidth
      />
      <div
        className="flex max-h-[320px] min-h-[120px] flex-col gap-1 overflow-y-auto"
        role="listbox"
        aria-label="Select a contact to merge"
      >
        {candidates.length === 0 ? (
          <Typography
            as="p"
            variant="body-small-default"
            className="px-3 py-4 text-center text-(--content-tertiary)"
          >
            No matching contacts
          </Typography>
        ) : (
          candidates.map((contact) => (
            <CandidateRow
              key={contact.id}
              contact={contact}
              onPick={() => onPick(contact.id)}
            />
          ))
        )}
      </div>
    </>
  );
}

function CandidateRow({
  contact,
  onPick,
}: { contact: ContactPayload; onPick: () => void }) {
  const channelLabel = mergeDialogChannelTypeLabels(contact).join(" | ") || undefined;
  return (
    <PanelItem asChild label="">
      <button
        type="button"
        onClick={onPick}
        role="option"
        aria-selected="false"
        className="flex h-auto w-full items-center gap-2 rounded-[6px] px-[8px] py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-medium-default">
            {contact.displayName}
          </span>
          {channelLabel ? (
            <span className="truncate text-body-small-default text-(--content-tertiary)">
              {channelLabel}
            </span>
          ) : null}
        </span>
      </button>
    </PanelItem>
  );
}

function MergeSummary({
  survivor,
  donor,
}: { survivor: ContactPayload; donor: ContactPayload }) {
  const survivorLabel = formatSurvivorName(survivor);
  const { moved, duplicates } = classifyMergedChannels(survivor, donor);

  return (
    <ul className="flex flex-col gap-2 text-body-medium-lighter text-(--content-secondary)">
      <li>
        <span className="text-(--content-default)">
          &ldquo;{donor.displayName}&rdquo;
        </span>{" "}
        will be deleted.
      </li>
      <li>
        {moved.length === 0
          ? `No new channels will move to ${survivorLabel}.`
          : `${moved.length} channel${moved.length === 1 ? "" : "s"} will move to ${survivorLabel}: ${moved.map((ch) => describeChannel(ch.type)).join(", ")}.`}
      </li>
      {duplicates.length > 0 ? (
        <li className="text-(--content-tertiary)">
          {duplicates.length} duplicate channel
          {duplicates.length === 1 ? "" : "s"} already on {survivorLabel}{" "}
          (skipped).
        </li>
      ) : null}
      {donor.notes ? (
        <li>Notes from the merged contact will be appended.</li>
      ) : null}
      <li className="text-(--content-tertiary)">This cannot be undone.</li>
    </ul>
  );
}

function MergeEmptyState() {
  return (
    <Typography
      as="p"
      variant="body-medium-lighter"
      className="px-3 py-6 text-center text-(--content-tertiary)"
    >
      No other contacts available to merge.
    </Typography>
  );
}

export function formatSurvivorName(contact: ContactPayload): string {
  if (contact.role === "guardian") {
    if (
      !contact.displayName ||
      contact.displayName.startsWith("vellum-principal-")
    ) {
      return "you";
    }
    return `${contact.displayName} (you)`;
  }
  return contact.displayName || "this contact";
}

const CHANNEL_TYPE_LABEL: Record<string, string> = {
  slack: "Slack",
  telegram: "Telegram",
  phone: "Phone",
  email: "Email",
  whatsapp: "WhatsApp",
};

function describeChannel(type: string): string {
  return CHANNEL_TYPE_LABEL[type.toLowerCase()] ?? type;
}

export function classifyMergedChannels(
  survivor: ContactPayload,
  donor: ContactPayload,
): {
  moved: ContactPayload["channels"];
  duplicates: ContactPayload["channels"];
} {
  const moved: ContactPayload["channels"] = [];
  const duplicates: ContactPayload["channels"] = [];
  for (const dc of donor.channels) {
    if (dc.status === "revoked") continue;
    const exists = survivor.channels.some(
      (sc) =>
        sc.type === dc.type &&
        sc.address.toLowerCase() === dc.address.toLowerCase(),
    );
    if (exists) duplicates.push(dc);
    else moved.push(dc);
  }
  return { moved, duplicates };
}

function mergeDialogChannelTypeLabels(contact: ContactPayload): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const ch of contact.channels) {
    if (ch.status === "revoked") continue;
    const key = ch.type.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(CHANNEL_TYPE_LABEL[key] ?? ch.type);
  }
  return labels;
}
