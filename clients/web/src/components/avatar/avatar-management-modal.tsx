import { ChevronLeft, ChevronRight, Image as ImageIcon, Sparkles, Wrench, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Button, Input } from "@vellumai/design-library";

import { AvatarCustomizationPanel } from "@/components/avatar/avatar-customization-panel";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { uploadAvatarImage } from "@/assistant/avatar-api";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

type ModalView = "actions" | "character-builder";

interface AvatarManagementModalProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  onSaveCharacter: (traits: CharacterTraits) => void;
  onUploadImage: () => void;
  onGenerateWithAI?: () => void;
  /** Current assistant name — shows the name editor when provided
   *  together with `onRenameSubmit`. */
  assistantName?: string;
  /** Called with the new trimmed name; the caller runs the rename. */
  onRenameSubmit?: (name: string) => void;
  /** A rename is in flight — the name editor locks and shows progress. */
  isRenaming?: boolean;
}

export function AvatarManagementModal({
  open,
  onClose,
  assistantId,
  components,
  traits,
  customImageUrl,
  onSaveCharacter,
  onUploadImage,
  onGenerateWithAI,
  assistantName,
  onRenameSubmit,
  isRenaming = false,
}: AvatarManagementModalProps) {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<ModalView>("actions");
  const [isUploading, setIsUploading] = useState(false);
  const [nameDraft, setNameDraft] = useState(assistantName ?? "");

  // Re-seed the draft whenever the modal opens (or a rename lands and the
  // canonical name changes underneath it).
  useEffect(() => {
    if (open) {
      setNameDraft(assistantName ?? "");
    }
  }, [open, assistantName]);

  const trimmedDraft = nameDraft.trim();
  const canSaveName =
    Boolean(onRenameSubmit) &&
    !isRenaming &&
    trimmedDraft.length > 0 &&
    trimmedDraft !== (assistantName ?? "");

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setView("actions");
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view === "character-builder") {
          setView("actions");
        } else {
          handleClose();
        }
      }
    },
    [handleClose, view],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleBack = useCallback(() => {
    setView("actions");
  }, []);

  const handleBuildCharacter = useCallback(() => {
    setView("character-builder");
  }, []);

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      setIsUploading(true);
      const ok = await uploadAvatarImage(assistantId, file);
      setIsUploading(false);

      if (ok) {
        onUploadImage();
        handleClose();
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [assistantId, onUploadImage, handleClose],
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleGenerateWithAI = useCallback(() => {
    handleClose();
    onGenerateWithAI?.();
  }, [handleClose, onGenerateWithAI]);

  const handleCharacterSave = useCallback(
    (savedTraits: CharacterTraits) => {
      onSaveCharacter(savedTraits);
      handleClose();
    },
    [onSaveCharacter, handleClose],
  );

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div
        className="mx-4 flex w-full max-w-md flex-col rounded-xl border shadow-xl"
        style={{
          backgroundColor: "var(--surface-lift)",
          borderColor: "var(--border-base)",
          maxHeight: "85vh",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: "var(--border-base)" }}
        >
          <div className="flex items-center gap-2">
            {view === "character-builder" && (
              <button
                type="button"
                onClick={handleBack}
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                aria-label="Back"
              >
                <ChevronLeft className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
              </button>
            )}
            <h2
              id={titleId}
              className="text-title-small"
              style={{ color: "var(--content-default)" }}
            >
              {view === "character-builder" ? "Build a Character" : "Update Avatar"}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Close"
          >
            <X className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
          </button>
        </div>

        <div className="overflow-y-auto p-6">
          {view === "actions" ? (
            <div className="flex flex-col items-center gap-6">
              <ChatAvatar
                components={components}
                traits={traits}
                customImageUrl={customImageUrl}
                size={120}
                interactive
              />

              {assistantName !== undefined && onRenameSubmit && (
                <form
                  className="flex w-full items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (canSaveName) {
                      onRenameSubmit(trimmedDraft);
                    }
                  }}
                >
                  <Input
                    label="Name"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    disabled={isRenaming}
                    maxLength={40}
                    fullWidth
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!canSaveName}
                    className="shrink-0"
                  >
                    {isRenaming ? "Saving…" : "Save"}
                  </Button>
                </form>
              )}

              <div className="w-full space-y-2">
                <button
                  type="button"
                  onClick={handleBuildCharacter}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80"
                  style={{
                    borderColor: "var(--border-base)",
                    backgroundColor: "var(--surface-lift)",
                  }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "color-mix(in oklab, var(--content-tertiary) 16%, transparent)" }}
                  >
                    <Wrench className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
                  </div>
                  <div className="flex-1 text-left">
                    <p
                      className="text-body-medium-default"
                      style={{ color: "var(--content-default)" }}
                    >
                      Build a Character
                    </p>
                    <p
                      className="text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      Build your own character
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0" style={{ color: "var(--content-tertiary)" }} />
                </button>

                <button
                  type="button"
                  onClick={handleUploadClick}
                  disabled={isUploading}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: "var(--border-base)",
                    backgroundColor: "var(--surface-lift)",
                  }}
                >
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "color-mix(in oklab, var(--content-tertiary) 16%, transparent)" }}
                  >
                    <ImageIcon className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
                  </div>
                  <div className="flex-1 text-left">
                    <p
                      className="text-body-medium-default"
                      style={{ color: "var(--content-default)" }}
                    >
                      {isUploading ? "Uploading..." : "Upload Image"}
                    </p>
                    <p
                      className="text-body-small-default"
                      style={{ color: "var(--content-tertiary)" }}
                    >
                      Choose an image from your computer
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0" style={{ color: "var(--content-tertiary)" }} />
                </button>

                {onGenerateWithAI && (
                  <button
                    type="button"
                    onClick={handleGenerateWithAI}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:opacity-80"
                    style={{
                      borderColor: "var(--border-base)",
                      backgroundColor: "var(--surface-lift)",
                    }}
                  >
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: "color-mix(in oklab, var(--content-tertiary) 16%, transparent)" }}
                    >
                      <Sparkles className="h-4 w-4" style={{ color: "var(--content-secondary)" }} />
                    </div>
                    <div className="flex-1 text-left">
                      <p
                        className="text-body-medium-default"
                        style={{ color: "var(--content-default)" }}
                      >
                        Generate with AI
                      </p>
                      <p
                        className="text-body-small-default"
                        style={{ color: "var(--content-tertiary)" }}
                      >
                        Create an avatar through chat
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0" style={{ color: "var(--content-tertiary)" }} />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <AvatarCustomizationPanel
              assistantId={assistantId}
              initialTraits={traits}
              onSave={handleCharacterSave}
              onCancel={handleBack}
            />
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>,
    document.body,
  );
}
