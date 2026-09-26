import { useId, useState } from "react";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Select } from "@vellumai/design-library/components/select";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

type ChatsSettingsAutoArchive = Pick<
  NonNullable<ConfigGetResponse["conversations"]>["autoArchive"],
  "enabled" | "afterDays"
>;

export interface ChatsSettingsValues {
  autoArchive: ChatsSettingsAutoArchive;
  newMessageEnabled: NonNullable<
    ConfigGetResponse["notifications"]
  >["newMessageEnabled"];
}

export interface ChatsSettingsChanges {
  conversations?: { autoArchive: Partial<ChatsSettingsAutoArchive> };
  notifications?: Pick<ChatsSettingsValues, "newMessageEnabled">;
}

interface ChatsSettingsFormProps {
  values: ChatsSettingsValues;
  saveStatus: "idle" | "pending" | "error";
  onSave: (changes: ChatsSettingsChanges) => void;
  onCancel: () => void;
}

const ARCHIVE_DAYS = [
  1, 7, 14, 30,
] as const satisfies readonly ChatsSettingsAutoArchive["afterDays"][];
const TOGGLE_CLASSES =
  "flex-row-reverse items-start gap-4 [&>div]:flex-1 [&>div>span]:text-[var(--content-secondary)] [&>button]:before:absolute [&>button]:before:-inset-x-1 [&>button]:before:-inset-y-2.5";

function changedSettings(
  initial: ChatsSettingsValues,
  draft: ChatsSettingsValues,
): ChatsSettingsChanges {
  const autoArchive: Partial<ChatsSettingsAutoArchive> = {};
  if (draft.autoArchive.enabled !== initial.autoArchive.enabled) {
    autoArchive.enabled = draft.autoArchive.enabled;
  }
  if (draft.autoArchive.afterDays !== initial.autoArchive.afterDays) {
    autoArchive.afterDays = draft.autoArchive.afterDays;
  }
  return {
    ...(Object.keys(autoArchive).length > 0
      ? { conversations: { autoArchive } }
      : {}),
    ...(draft.newMessageEnabled !== initial.newMessageEnabled
      ? { notifications: { newMessageEnabled: draft.newMessageEnabled } }
      : {}),
  };
}

export function ChatsSettingsForm({
  values,
  saveStatus,
  onSave,
  onCancel,
}: ChatsSettingsFormProps) {
  const { t } = useTranslation("chat");
  const daysId = useId();
  // A remote refresh must not turn untouched fields into writes.
  const [initial] = useState(() => structuredClone(values));
  const [draft, setDraft] = useState(initial);
  const changes = changedSettings(initial, draft);
  const dirty = Object.keys(changes).length > 0;
  const saving = saveStatus === "pending";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && dirty) {
          onSave(changes);
        }
      }}
    >
      <Modal.Body className="min-h-0 space-y-5 pb-0" aria-busy={saving}>
        <Toggle
          label={t("chatsSettingsModal.autoArchive")}
          helperText={t("chatsSettingsModal.autoArchiveHelper")}
          checked={draft.autoArchive.enabled}
          onChange={(enabled) =>
            setDraft({
              ...draft,
              autoArchive: { ...draft.autoArchive, enabled },
            })
          }
          disabled={saving}
          className={TOGGLE_CLASSES}
        />
        <div className="flex items-center justify-between gap-4">
          <Typography as="label" htmlFor={daysId} variant="body-medium-default">
            {t("chatsSettingsModal.timeToArchive")}
          </Typography>
          <Select
            id={daysId}
            size="compact"
            fullWidth={false}
            value={String(draft.autoArchive.afterDays)}
            options={ARCHIVE_DAYS.map((days) => ({
              value: String(days),
              label: t("chatsSettingsModal.days", { count: days }),
            }))}
            onChange={(value) => {
              const afterDays = ARCHIVE_DAYS.find(
                (days) => String(days) === value,
              );
              if (afterDays !== undefined) {
                setDraft({
                  ...draft,
                  autoArchive: { ...draft.autoArchive, afterDays },
                });
              }
            }}
            disabled={saving || !draft.autoArchive.enabled}
            className="min-w-24"
          />
        </div>
        <div className="border-t border-[var(--border-subtle)] pt-5">
          <Toggle
            label={t("chatsSettingsModal.notifications")}
            helperText={t("chatsSettingsModal.notificationsHelper")}
            checked={draft.newMessageEnabled}
            onChange={(newMessageEnabled) =>
              setDraft({ ...draft, newMessageEnabled })
            }
            disabled={saving}
            className={TOGGLE_CLASSES}
          />
        </div>
        {saveStatus === "error" ? (
          <Notice tone="error">{t("chatsSettingsModal.saveError")}</Notice>
        ) : null}
      </Modal.Body>
      <span role="status" className="sr-only">
        {saving ? t("chatsSettingsModal.saving") : ""}
      </span>
      <Modal.Footer className="shrink-0">
        <Button
          type="button"
          variant="outlined"
          className="text-[var(--content-default)] disabled:text-[var(--content-disabled)]"
          onClick={onCancel}
          disabled={saving}
        >
          {t("chatsSettingsModal.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          className="[[data-theme=velvet]_&]:enabled:bg-[var(--primary-active)]"
          disabled={!dirty}
          loading={saving}
        >
          {saving
            ? t("chatsSettingsModal.saving")
            : t("chatsSettingsModal.confirm")}
        </Button>
      </Modal.Footer>
    </form>
  );
}
