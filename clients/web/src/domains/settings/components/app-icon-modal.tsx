/**
 * The app icon picker.
 *
 * Cycles eyes and color the way the avatar builder cycles traits, previews the
 * pair as iOS draws it on the home screen, and applies the one the user lands
 * on. Nothing is applied by cycling: iOS puts up a system alert the app cannot
 * suppress on every icon change, so the swap waits for a press on Set.
 *
 * Prop-driven, in the shape of `AvatarManagementModal`. {@link AppIconRow}
 * owns the shell snapshot and hands down what it found, so what this modal
 * offers is exactly what the installed build can carry out.
 */
import { useEffect, useState } from "react";

import { AppIconPreview } from "@/components/avatar/app-icon-preview";
import { TraitCycleRow } from "@/components/avatar/trait-cycle-row";
import { useTranslation } from "@/i18n";
import {
  DEFAULT_APP_ICON_TRAITS,
  appIconNameForTraits,
  traitsForAppIconName,
} from "@/utils/avatar-app-icon";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import type { CharacterComponents } from "@/types/avatar";

/** Size of the live preview, matching the avatar builder's own. */
const PREVIEW_SIZE = 160;

export interface AppIconModalProps {
  open: boolean;
  onClose: () => void;
  /** Trait catalog the two rows cycle. Null while it is still loading. */
  components: CharacterComponents | null;
  /** The alternate icon on the home screen now, or null for the default. */
  currentIcon: string | null;
  /** The icon the assistant's avatar maps to, or null when it maps to none. */
  targetIcon: string | null;
  /** True while `targetIcon` is bundled and is not the icon already applied. */
  canSyncAvatar: boolean;
  /** Every icon name the installed shell reports as bundled. */
  availableIcons: string[];
  /** Applies a bundled icon, resolving false when the home screen kept the old one. */
  onApply: (name: string) => Promise<boolean>;
  /** Restores the default icon, resolving as `onApply` does. */
  onReset: () => Promise<boolean>;
}

/** Step a trait index, wrapping at both ends. */
function stepIndex(index: number, total: number, step: number): number {
  if (total <= 0) {
    return 0;
  }
  return (index + step + total) % total;
}

/** Where a trait id sits in its catalog list; the first entry when absent. */
function indexOfTrait(
  entries: readonly { id: string }[] | undefined,
  id: string,
): number {
  const index = entries?.findIndex((entry) => entry.id === id) ?? -1;
  return index >= 0 ? index : 0;
}

export function AppIconModal({
  open,
  onClose,
  components,
  currentIcon,
  targetIcon,
  canSyncAvatar,
  availableIcons,
  onApply,
  onReset,
}: AppIconModalProps) {
  const { t } = useTranslation("settings");
  const [eyeIndex, setEyeIndex] = useState(0);
  const [colorIndex, setColorIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // The shortcut is offered while it has somewhere to go: a character avatar
  // whose icon the installed build bundles and the home screen is not already
  // showing.
  const avatarTraits = canSyncAvatar ? traitsForAppIconName(targetIcon) : null;

  // Open on what the home screen already holds, so the picker starts from the
  // user's icon rather than from the top of the catalog. A user who has never
  // swapped starts on their avatar's pair, and a user with no avatar of their
  // own on the pair the default icon is drawn from.
  useEffect(() => {
    if (!open) {
      return;
    }
    const seed =
      traitsForAppIconName(currentIcon) ??
      traitsForAppIconName(targetIcon) ??
      DEFAULT_APP_ICON_TRAITS;
    setEyeIndex(indexOfTrait(components?.eyeStyles, seed.eyeStyle));
    setColorIndex(indexOfTrait(components?.colors, seed.color));
    setFailed(false);
  }, [open, components, currentIcon, targetIcon]);

  const eyeStyle = components?.eyeStyles[eyeIndex];
  const color = components?.colors[colorIndex];
  const eyeStyleId = eyeStyle?.id ?? DEFAULT_APP_ICON_TRAITS.eyeStyle;
  const colorId = color?.id ?? DEFAULT_APP_ICON_TRAITS.color;
  const name = appIconNameForTraits(eyeStyleId, colorId);

  // Version skew reads as a disabled Set rather than an error: a pair this
  // build knows and the installed binary ships no bundle for cannot be applied.
  const canApply = name !== currentIcon && availableIcons.includes(name);

  // iOS can refuse a swap, and it can take one and leave the home screen
  // alone. Either way the picker stays up and says so, since the icon the user
  // was trying to change is still the icon they have.
  const run = async (action: () => Promise<boolean>) => {
    setPending(true);
    setFailed(false);
    try {
      if (await action()) {
        onClose();
      } else {
        setFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  const handleMatchAvatar = () => {
    if (avatarTraits === null) {
      return;
    }
    setEyeIndex(indexOfTrait(components?.eyeStyles, avatarTraits.eyeStyle));
    setColorIndex(indexOfTrait(components?.colors, avatarTraits.color));
    setFailed(false);
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content size="sm" data-testid="app-icon-modal">
        <Modal.Header>
          <Modal.Title>{t("appIcon.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <div className="flex justify-center">
            <div className="rounded-2xl bg-[var(--surface-sunken)] p-6">
              <AppIconPreview
                components={components}
                eyeStyle={eyeStyleId}
                color={colorId}
                size={PREVIEW_SIZE}
              />
            </div>
          </div>

          <div className="space-y-3">
            <TraitCycleRow
              label={t("appIcon.eyes")}
              value={eyeStyleId}
              onPrev={() =>
                setEyeIndex(
                  stepIndex(eyeIndex, components?.eyeStyles.length ?? 0, -1),
                )
              }
              onNext={() =>
                setEyeIndex(
                  stepIndex(eyeIndex, components?.eyeStyles.length ?? 0, 1),
                )
              }
            />
            <TraitCycleRow
              label={t("appIcon.color")}
              value={colorId}
              colorHex={color?.hex}
              onPrev={() =>
                setColorIndex(
                  stepIndex(colorIndex, components?.colors.length ?? 0, -1),
                )
              }
              onNext={() =>
                setColorIndex(
                  stepIndex(colorIndex, components?.colors.length ?? 0, 1),
                )
              }
            />
          </div>

          {avatarTraits !== null ? (
            <Button
              type="button"
              variant="outlined"
              fullWidth
              disabled={pending}
              onClick={handleMatchAvatar}
            >
              {t("appIcon.matchAvatar")}
            </Button>
          ) : null}

          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {t("appIcon.note")}
          </p>
          {failed ? (
            <p
              role="alert"
              className="text-body-small-default text-[color:var(--content-negative)]"
            >
              {t("appIcon.error")}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          {currentIcon !== null ? (
            <Button
              type="button"
              variant="outlined"
              disabled={pending}
              onClick={() => void run(onReset)}
            >
              {t("appIcon.reset")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            disabled={pending || !canApply}
            onClick={() => void run(() => onApply(name))}
          >
            {t("appIcon.apply")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
