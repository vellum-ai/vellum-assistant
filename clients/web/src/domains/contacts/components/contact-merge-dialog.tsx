import { ArrowLeft, GitMerge, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Typography } from "@vellumai/design-library/components/typography";

import { channelTypeLabel } from "@/domains/contacts/channel-type-labels";
import type { ContactPayload } from "@/domains/contacts/types";
import { t as translate, Trans, useTranslation } from "@/i18n";

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
  const { t } = useTranslation("contacts");
  const [search, setSearch] = useState("");
  const [donorId, setDonorId] = useState<string | null>(null);

  useEffect(() => {
    if (donorId && !candidates.some((c) => c.id === donorId)) {
      setDonorId(null);
    }
  }, [candidates, donorId]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return candidates;
    }
    return candidates.filter((c) => c.displayName.toLowerCase().includes(q));
  }, [candidates, search]);

  const donor = donorId
    ? (candidates.find((c) => c.id === donorId) ?? null)
    : null;

  const survivorLabel = formatSurvivorName(survivor);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header icon={GitMerge}>
          <Modal.Title>
            {donor
              ? t("contactMergeDialog.titlePicked", {
                  donor: donor.displayName,
                  survivor: survivorLabel,
                })
              : t("contactMergeDialog.titlePicking", {
                  survivor: survivorLabel,
                })}
          </Modal.Title>
          <Modal.Description>
            {donor
              ? t("contactMergeDialog.descriptionPicked")
              : t("contactMergeDialog.descriptionPicking")}
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
                {t("actions.back")}
              </Button>
              <Button
                variant="danger"
                onClick={() => onMerge(donor.id)}
                disabled={pending}
              >
                {pending ? t("actions.merging") : t("contactMergeDialog.confirm")}
              </Button>
            </>
          ) : (
            <Button variant="outlined" onClick={onClose} disabled={pending}>
              {t("actions.cancel")}
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
  const { t } = useTranslation("contacts");

  return (
    <>
      <Input
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={t("contactMergeDialog.searchPlaceholder")}
        leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
        fullWidth
      />
      <div
        className="flex max-h-[320px] min-h-[120px] flex-col gap-1 overflow-y-auto"
        role="listbox"
        aria-label={t("contactMergeDialog.listAriaLabel")}
      >
        {candidates.length === 0 ? (
          <Typography
            as="p"
            variant="body-small-default"
            className="px-3 py-4 text-center text-(--content-tertiary)"
          >
            {t("contactsList.noMatches")}
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
}: {
  contact: ContactPayload;
  onPick: () => void;
}) {
  const channelLabel =
    mergeDialogChannelTypeLabels(contact).join(" | ") || undefined;
  return (
    <PanelItem asChild>
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
}: {
  survivor: ContactPayload;
  donor: ContactPayload;
}) {
  const { t } = useTranslation("contacts");
  const survivorLabel = formatSurvivorName(survivor);
  const { moved, duplicates } = classifyMergedChannels(survivor, donor);

  // ICU `plural` picks the category through `Intl.PluralRules`, so both counts
  // agree in languages with more than the two forms English has. The zero case
  // is its own `=0` branch rather than a separate key, because it is the same
  // sentence with nothing to list.
  return (
    <ul className="flex flex-col gap-2 text-body-medium-lighter text-(--content-secondary)">
      <li>
        <Trans
          i18nKey="contactMergeDialog.donorDeleted"
          ns="contacts"
          values={{ donor: donor.displayName }}
          components={{ donor: <span className="text-(--content-default)" /> }}
        />
      </li>
      <li>
        {t("contactMergeDialog.channelsMoved", {
          count: moved.length,
          survivor: survivorLabel,
          channels: moved.map((ch) => channelTypeLabel(ch.type)).join(", "),
        })}
      </li>
      {duplicates.length > 0 ? (
        <li className="text-(--content-tertiary)">
          {t("contactMergeDialog.duplicatesSkipped", {
            count: duplicates.length,
            survivor: survivorLabel,
          })}
        </li>
      ) : null}
      {donor.notes ? <li>{t("contactMergeDialog.notesAppended")}</li> : null}
      <li className="text-(--content-tertiary)">
        {t("contactMergeDialog.irreversible")}
      </li>
    </ul>
  );
}

function MergeEmptyState() {
  const { t } = useTranslation("contacts");

  return (
    <Typography
      as="p"
      variant="body-medium-lighter"
      className="px-3 py-6 text-center text-(--content-tertiary)"
    >
      {t("contactMergeDialog.empty")}
    </Typography>
  );
}

/**
 * How the surviving contact is named inside the dialog's sentences.
 *
 * Reads the bound `t` rather than the hook: this is called from render and is
 * also exported for the page, so it cannot take a hook of its own. Every
 * caller renders inside a component that does subscribe, so a locale switch
 * still repaints it.
 */
export function formatSurvivorName(contact: ContactPayload): string {
  if (contact.role === "guardian") {
    if (
      !contact.displayName ||
      contact.displayName.startsWith("vellum-principal-")
    ) {
      return translate("survivorName.you", { ns: "contacts" });
    }
    return translate("survivorName.youNamed", {
      ns: "contacts",
      name: contact.displayName,
    });
  }
  return (
    contact.displayName ||
    translate("survivorName.thisContact", { ns: "contacts" })
  );
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
    if (dc.status === "revoked") {
      continue;
    }
    const exists = survivor.channels.some(
      (sc) =>
        sc.type === dc.type &&
        sc.address.toLowerCase() === dc.address.toLowerCase(),
    );
    if (exists) {
      duplicates.push(dc);
    } else {
      moved.push(dc);
    }
  }
  return { moved, duplicates };
}

function mergeDialogChannelTypeLabels(contact: ContactPayload): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const ch of contact.channels) {
    if (ch.status === "revoked") {
      continue;
    }
    const key = ch.type.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(channelTypeLabel(key));
  }
  return labels;
}
