import type { RefObject } from "react";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";

import {
  ChatsSettingsForm,
  type ChatsSettingsChanges,
  type ChatsSettingsValues,
} from "./chats-settings-form";

export type {
  ChatsSettingsChanges,
  ChatsSettingsValues,
} from "./chats-settings-form";

export type ChatsSettingsLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unsupported" }
  | { status: "ready"; values: ChatsSettingsValues };

export interface ChatsSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ChatsSettingsLoadState;
  saveStatus: "idle" | "pending" | "error";
  onSave: (changes: ChatsSettingsChanges) => void;
  onRetryLoad: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ChatsSettingsModal({
  open,
  onOpenChange,
  state,
  saveStatus,
  onSave,
  onRetryLoad,
  returnFocusRef,
}: ChatsSettingsModalProps) {
  const { t } = useTranslation("chat");
  const saving = saveStatus === "pending";
  const dismiss = () => {
    if (!saving) {
      onOpenChange(false);
    }
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          dismiss();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        dismissOnOverlayClick={!saving}
        className="max-h-[calc(100dvh-2rem-var(--safe-area-inset-top,env(safe-area-inset-top,0px))-var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        overlayClassName="pt-[max(1rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] pb-[max(1rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]"
        onEscapeKeyDown={(event) => {
          if (saving) {
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <Modal.Header className="shrink-0 pr-4">
          <Modal.Title className="[&>span]:whitespace-normal">
            {t("chatsSettingsModal.title")}
          </Modal.Title>
          <Modal.Description className="sr-only">
            {t("chatsSettingsModal.description")}
          </Modal.Description>
        </Modal.Header>
        {state.status === "ready" ? (
          <ChatsSettingsForm
            values={state.values}
            saveStatus={saveStatus}
            onSave={onSave}
            onCancel={dismiss}
          />
        ) : (
          <>
            <Modal.Body className="min-h-0">
              {state.status === "loading" ? (
                <Typography as="p" variant="body-small-default" role="status">
                  {t("chatsSettingsModal.loading")}
                </Typography>
              ) : state.status === "error" ? (
                <Notice
                  tone="error"
                  actions={
                    <Button
                      variant="outlined"
                      className="text-[var(--content-default)] disabled:text-[var(--content-disabled)]"
                      onClick={onRetryLoad}
                    >
                      {t("chatsSettingsModal.retry")}
                    </Button>
                  }
                >
                  {t("chatsSettingsModal.loadError")}
                </Notice>
              ) : (
                <Notice tone="info">
                  {t("chatsSettingsModal.unsupported")}
                </Notice>
              )}
            </Modal.Body>
            <Modal.Footer className="shrink-0">
              <Button
                variant="outlined"
                className="text-[var(--content-default)] disabled:text-[var(--content-disabled)]"
                onClick={dismiss}
                disabled={saving}
              >
                {t("chatsSettingsModal.cancel")}
              </Button>
              <Button variant="primary" disabled>
                {t("chatsSettingsModal.confirm")}
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
