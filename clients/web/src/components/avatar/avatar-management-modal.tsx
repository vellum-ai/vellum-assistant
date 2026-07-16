import { ChevronLeft, ChevronRight, Dices, Upload } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button, Modal } from "@vellumai/design-library";

import {
  fetchCharacterComponents,
  saveCharacterTraits,
  uploadAvatarImage,
} from "@/assistant/avatar-api";
import { AvatarRenderer } from "@/components/avatar-renderer";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

interface AvatarManagementModalProps {
  open: boolean;
  onClose: () => void;
  assistantId: string;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  onSaveCharacter: (traits: CharacterTraits) => void;
  onUploadImage: () => void;
  /** Current assistant name — shows the name editor when provided
   *  together with `onRenameSubmit`. */
  assistantName?: string;
  /** Called with the new trimmed name; the caller runs the rename. */
  onRenameSubmit?: (name: string) => void;
  /** A rename is in flight — the name editor locks and shows progress. */
  isRenaming?: boolean;
}

/** What the preview area shows: the character builder (primary) or the
 *  uploaded custom image (secondary — only reachable when one exists). */
type PreviewMode = "character" | "custom";

function cycleIndex(current: number, total: number, direction: "forward" | "backward"): number {
  if (direction === "forward") {
    return (current + 1) % total;
  }
  return (current - 1 + total) % total;
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
  assistantName,
  onRenameSubmit,
  isRenaming = false,
}: AvatarManagementModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fallback fetch for assistants whose cached avatar query resolved without
  // components (e.g. a custom image with no traits sidecar).
  const [fetchedComponents, setFetchedComponents] = useState<CharacterComponents | null>(null);
  const [isFetchingComponents, setIsFetchingComponents] = useState(false);
  const resolvedComponents = components ?? fetchedComponents;

  const [bodyIndex, setBodyIndex] = useState(0);
  const [eyeIndex, setEyeIndex] = useState(0);
  const [colorIndex, setColorIndex] = useState(0);

  const [previewMode, setPreviewMode] = useState<PreviewMode>("character");
  // Instant preview for a just-uploaded file, so the modal doesn't wait for
  // the parent's avatar query to refetch before showing the image.
  const [localUploadUrl, setLocalUploadUrl] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [nameDraft, setNameDraft] = useState(assistantName ?? "");

  const displayImageUrl = localUploadUrl ?? customImageUrl;
  const hasCustomImage = Boolean(displayImageUrl);

  // Re-seed the draft whenever the modal opens (or a rename lands and the
  // canonical name changes underneath it).
  useEffect(() => {
    if (open) {
      setNameDraft(assistantName ?? "");
    }
  }, [open, assistantName]);

  // Start on the custom image when one is set, but only on open — mid-session
  // prop refreshes (e.g. the post-upload refetch) must not yank the user out
  // of the builder.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPreviewMode(customImageUrl ? "custom" : "character");
    }
    wasOpenRef.current = open;
  }, [open, customImageUrl]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (resolvedComponents && traits) {
      const bi = resolvedComponents.bodyShapes.findIndex((b) => b.id === traits.bodyShape);
      const ei = resolvedComponents.eyeStyles.findIndex((e) => e.id === traits.eyeStyle);
      const ci = resolvedComponents.colors.findIndex((c) => c.id === traits.color);
      setBodyIndex(bi >= 0 ? bi : 0);
      setEyeIndex(ei >= 0 ? ei : 0);
      setColorIndex(ci >= 0 ? ci : 0);
    } else {
      setBodyIndex(0);
      setEyeIndex(0);
      setColorIndex(0);
    }
  }, [open, resolvedComponents, traits]);

  useEffect(() => {
    if (!open || resolvedComponents || isFetchingComponents) {
      return;
    }
    let cancelled = false;
    setIsFetchingComponents(true);
    void fetchCharacterComponents(assistantId).then((data) => {
      if (cancelled) {
        return;
      }
      setFetchedComponents(data);
      setIsFetchingComponents(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, resolvedComponents, isFetchingComponents, assistantId]);

  // Revoke the local preview URL when it is replaced or on unmount.
  useEffect(() => {
    if (!localUploadUrl) {
      return;
    }
    return () => {
      URL.revokeObjectURL(localUploadUrl);
    };
  }, [localUploadUrl]);

  // Drop the local upload preview once the modal closes — the modal stays
  // mounted between opens, and on the next open the parent's refetched
  // `customImageUrl` is the source of truth. Without this, a stale blob keeps
  // resurrecting the "uploaded image" affordance after the image was replaced
  // by a character.
  useEffect(() => {
    if (!open) {
      setLocalUploadUrl(null);
    }
  }, [open]);

  const trimmedDraft = nameDraft.trim();
  const nameChanged =
    Boolean(onRenameSubmit) &&
    trimmedDraft.length > 0 &&
    trimmedDraft !== (assistantName ?? "");

  const handleRandomize = useCallback(() => {
    if (!resolvedComponents) {
      return;
    }
    setPreviewMode("character");
    setBodyIndex(Math.floor(Math.random() * resolvedComponents.bodyShapes.length));
    setEyeIndex(Math.floor(Math.random() * resolvedComponents.eyeStyles.length));
    setColorIndex(Math.floor(Math.random() * resolvedComponents.colors.length));
  }, [resolvedComponents]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
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
        setLocalUploadUrl(URL.createObjectURL(file));
        setPreviewMode("custom");
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [assistantId, onUploadImage],
  );

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (isSaving || isRenaming) {
        return;
      }

      if (nameChanged && onRenameSubmit) {
        onRenameSubmit(trimmedDraft);
      }

      // Traits are only written from the builder view — saving while viewing
      // the uploaded image keeps that image.
      const shouldSaveTraits = resolvedComponents && previewMode === "character";
      if (shouldSaveTraits) {
        const nextTraits: CharacterTraits = {
          bodyShape: resolvedComponents.bodyShapes[bodyIndex]!.id,
          eyeStyle: resolvedComponents.eyeStyles[eyeIndex]!.id,
          color: resolvedComponents.colors[colorIndex]!.id,
        };
        setIsSaving(true);
        try {
          await saveCharacterTraits(assistantId, nextTraits);
          // The daemon replaces the uploaded image with the character, so the
          // local preview of that image is no longer valid.
          setLocalUploadUrl(null);
          onSaveCharacter(nextTraits);
        } finally {
          setIsSaving(false);
        }
      }

      onClose();
    },
    [
      isSaving,
      isRenaming,
      nameChanged,
      onRenameSubmit,
      trimmedDraft,
      resolvedComponents,
      previewMode,
      bodyIndex,
      eyeIndex,
      colorIndex,
      assistantId,
      onSaveCharacter,
      onClose,
    ],
  );

  const currentBody = resolvedComponents?.bodyShapes[bodyIndex];
  const currentEye = resolvedComponents?.eyeStyles[eyeIndex];
  const currentColor = resolvedComponents?.colors[colorIndex];

  const showCustomView = previewMode === "custom" && hasCustomImage;

  const nameRow =
    assistantName !== undefined && onRenameSubmit ? (
      <NameRow
        value={nameDraft}
        onChange={setNameDraft}
        disabled={isRenaming}
      />
    ) : null;

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Update Avatar</Modal.Title>
        </Modal.Header>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSave}>
          <Modal.Body className="space-y-4">
            {showCustomView ? (
              <>
                <div className="flex justify-center">
                  <div className="rounded-2xl bg-[var(--surface-sunken)] p-6">
                    <img
                      src={displayImageUrl!}
                      alt="Uploaded avatar"
                      className="h-40 w-40 rounded-xl object-cover"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {nameRow}
                  <SwitchModeRow
                    label="Use a character instead"
                    description="Pick from our built-in avatars"
                    onClick={() => setPreviewMode("character")}
                    thumbnail={
                      resolvedComponents && currentBody && currentEye && currentColor ? (
                        <AvatarRenderer
                          components={resolvedComponents}
                          bodyShapeId={currentBody.id}
                          eyeStyleId={currentEye.id}
                          colorId={currentColor.id}
                          size={32}
                        />
                      ) : (
                        <Dices
                          className="h-4 w-4"
                          style={{ color: "var(--content-secondary)" }}
                        />
                      )
                    }
                  />
                </div>
              </>
            ) : !resolvedComponents ? (
              <>
                {nameRow}
                {isFetchingComponents ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-tertiary)]" />
                  </div>
                ) : (
                  <div className="py-8 text-center text-body-medium-lighter text-[var(--content-quiet)]">
                    Unable to load avatar components. Make sure your assistant is running.
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex justify-center">
                  <div className="rounded-2xl bg-[var(--surface-sunken)] p-6">
                    <AvatarRenderer
                      components={resolvedComponents}
                      bodyShapeId={currentBody!.id}
                      eyeStyleId={currentEye!.id}
                      colorId={currentColor!.id}
                      size={160}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {nameRow}
                  <CycleRow
                    label="Body"
                    value={currentBody!.id}
                    onPrev={() =>
                      setBodyIndex(
                        cycleIndex(bodyIndex, resolvedComponents.bodyShapes.length, "backward"),
                      )
                    }
                    onNext={() =>
                      setBodyIndex(
                        cycleIndex(bodyIndex, resolvedComponents.bodyShapes.length, "forward"),
                      )
                    }
                  />
                  <CycleRow
                    label="Eyes"
                    value={currentEye!.id}
                    onPrev={() =>
                      setEyeIndex(
                        cycleIndex(eyeIndex, resolvedComponents.eyeStyles.length, "backward"),
                      )
                    }
                    onNext={() =>
                      setEyeIndex(
                        cycleIndex(eyeIndex, resolvedComponents.eyeStyles.length, "forward"),
                      )
                    }
                  />
                  <CycleRow
                    label="Color"
                    value={currentColor!.id}
                    colorHex={currentColor!.hex}
                    onPrev={() =>
                      setColorIndex(
                        cycleIndex(colorIndex, resolvedComponents.colors.length, "backward"),
                      )
                    }
                    onNext={() =>
                      setColorIndex(
                        cycleIndex(colorIndex, resolvedComponents.colors.length, "forward"),
                      )
                    }
                  />
                </div>

                {hasCustomImage && (
                  <SwitchModeRow
                    label="Keep your uploaded image"
                    description="Saving the character replaces it"
                    onClick={() => setPreviewMode("custom")}
                    thumbnail={
                      <img
                        src={displayImageUrl!}
                        alt=""
                        className="h-8 w-8 rounded-md object-cover"
                      />
                    }
                  />
                )}
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="justify-between">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outlined"
                iconOnly={<Dices />}
                aria-label="Randomize"
                tooltip="Randomize"
                onClick={handleRandomize}
                disabled={!resolvedComponents}
              />
              <Button
                type="button"
                variant="outlined"
                iconOnly={<Upload />}
                aria-label="Upload image"
                tooltip="Upload image"
                onClick={handleUploadClick}
                disabled={isUploading}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={isSaving || isRenaming || isUploading}
            >
              {isSaving || isRenaming ? "Saving…" : "Save"}
            </Button>
          </Modal.Footer>
        </form>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleFileSelect}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

interface NameRowProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

/** Name editor styled like a `CycleRow` — same container and outline, with a
 *  ghost (borderless) text field sitting in the same centered value column as
 *  the cycle rows (content-sized input + a chevron-width spacer on the right,
 *  so the text lines up with Body/Eyes/Color values). */
function NameRow({ value, onChange, disabled }: NameRowProps) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3 py-2">
      <span className="text-body-small-default uppercase tracking-wider text-[var(--content-quiet)]">
        Name
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-[80px] items-center justify-center">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            maxLength={40}
            size={8}
            placeholder="Name"
            aria-label="Name"
            className="h-7 min-w-0 field-sizing-content bg-transparent text-center text-body-medium-default text-[var(--content-strong)] outline-none placeholder:text-[var(--content-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <span aria-hidden className="h-7 w-7 shrink-0" />
      </div>
    </label>
  );
}

interface SwitchModeRowProps {
  label: string;
  description: string;
  thumbnail: React.ReactNode;
  onClick: () => void;
}

/** Compact secondary row for hopping between the builder and the uploaded
 *  image without leaving the modal. */
function SwitchModeRow({ label, description, thumbnail, onClick }: SwitchModeRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-sunken)]">
        {thumbnail}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-medium-default text-[var(--content-strong)]">
          {label}
        </span>
        <span className="block truncate text-body-small-default text-[var(--content-quiet)]">
          {description}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--content-quiet)]" />
    </button>
  );
}

interface CycleRowProps {
  label: string;
  value: string;
  colorHex?: string;
  onPrev: () => void;
  onNext: () => void;
}

function CycleRow({ label, value, colorHex, onPrev, onNext }: CycleRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] px-3 py-2">
      <span className="text-body-small-default uppercase tracking-wider text-[var(--content-quiet)]">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          aria-label={`Previous ${label.toLowerCase()}`}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-[80px] items-center justify-center gap-2">
          {colorHex && (
            <div
              className="h-4 w-4 rounded-full border border-[var(--border-element)]"
              style={{ backgroundColor: colorHex }}
            />
          )}
          <span className="text-body-medium-default capitalize text-[var(--content-strong)]">
            {value}
          </span>
        </div>
        <button
          type="button"
          onClick={onNext}
          aria-label={`Next ${label.toLowerCase()}`}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--content-quiet)] transition-colors hover:bg-[var(--surface-active)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
