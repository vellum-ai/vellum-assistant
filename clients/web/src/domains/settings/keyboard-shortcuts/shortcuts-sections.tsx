import { RotateCcw, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { type ResolvedHotkey } from "@/runtime/hotkeys";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { ShortcutKeys } from "@vellumai/design-library/components/shortcut-keys";

import { useHotkeyRecorder } from "@/domains/settings/keyboard-shortcuts/use-hotkey-recorder";

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

function scopeSections(t: SettingsTranslate): {
  scope: ResolvedHotkey["scope"];
  title: string;
  description: string;
}[] {
  return [
    {
      scope: "global",
      title: t("shortcutsSections.globalTitle"),
      description: t("shortcutsSections.globalDescription"),
    },
    {
      scope: "menu",
      title: t("shortcutsSections.appTitle"),
      description: t("shortcutsSections.appDescription"),
    },
  ];
}

export interface ShortcutRowProps {
  hotkey: ResolvedHotkey;
  recording: boolean;
  conflictLabel: string | null;
  /**
   * Another way to bind the same command, offered beside the recorder.
   *
   * Fn is the only one today: it is not an accelerator, so it cannot be
   * recorded or held in `settings.hotkeys`, but to a user it is simply the
   * other thing Talk can be bound to and belongs in the same row rather than
   * in a control of its own.
   */
  alternateBinding?: ReactNode;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onReset: () => void;
  onRemove: () => void;
}

/**
 * One rebindable command: its current binding plus record / reset / remove
 * controls. Shared with Settings, Voice, which renders this same row for Talk
 * so the affordance is the one users already know. While recording, a keydown anywhere is captured by the page and
 * turned into an accelerator; this row just reflects the recording state and
 * surfaces a conflict message inline.
 */
export function ShortcutRow({
  hotkey,
  recording,
  conflictLabel,
  alternateBinding,
  onStartRecording,
  onCancelRecording,
  onReset,
  onRemove,
}: ShortcutRowProps) {
  const { t } = useTranslation("settings");
  const isUnbound = hotkey.accelerator === "";
  const isCustomized = hotkey.override !== null;

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-body-medium-lighter text-[var(--content-default)]">
          {hotkey.label}
        </div>
        {conflictLabel !== null && (
          <div className="text-body-small-default text-[var(--system-negative-strong)]">
            {t("shortcutsSections.alreadyUsedBy", { label: conflictLabel })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {alternateBinding}
        {recording ? (
          <span className="text-body-small-default text-[var(--content-secondary)]">
            {t("shortcutsSections.recordingHint")}
          </span>
        ) : isUnbound ? (
          // Not "Disabled": the command still works from its menu item, its
          // button, or its surface. What is absent is the shortcut, and for a
          // command that ships without one (Talk) this is the first thing the
          // user reads, not the result of them removing anything.
          <span className="text-body-small-default italic text-[var(--content-disabled)]">
            {t("shortcutsSections.none")}
          </span>
        ) : (
          <ShortcutKeys accelerator={hotkey.accelerator} />
        )}

        {recording ? (
          <Button variant="ghost" size="compact" onClick={onCancelRecording}>
            {t("shortcutsSections.cancel")}
          </Button>
        ) : (
          <Button
            variant="outlined"
            size="compact"
            onClick={onStartRecording}
            aria-label={t("shortcutsSections.recordShortcutAriaLabel", {
              label: hotkey.label,
            })}
          >
            {t("shortcutsSections.record")}
          </Button>
        )}

        <Button
          variant="ghost"
          size="compact"
          disabled={!isCustomized}
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          onClick={onReset}
          aria-label={t("shortcutsSections.resetShortcutAriaLabel", {
            label: hotkey.label,
          })}
        />
        <Button
          variant="ghost"
          size="compact"
          disabled={isUnbound}
          leftIcon={<X className="h-3.5 w-3.5" />}
          onClick={onRemove}
          aria-label={t("shortcutsSections.removeBindingAriaLabel", {
            label: hotkey.label,
          })}
        />
      </div>
    </div>
  );
}

/**
 * Electron-only sections for rebinding global and menu shortcuts, at parity
 * with the native app's Keyboard Shortcuts card. Reads the resolved catalog
 * over the typed `hotkeys` bridge, records new bindings from live keypresses,
 * blocks conflicting saves, and stays in sync with changes made in other
 * windows. The caller (the Preferences modal on Settings → General) only
 * renders this on Electron, so the bridge calls here always have a host.
 */
export function ShortcutsSections() {
  const { t } = useTranslation("settings");
  const {
    catalog,
    recordingKey,
    conflict,
    startRecording,
    stopRecording,
    resetHotkey,
    removeHotkey,
  } = useHotkeyRecorder();

  // Only rebindable commands get a row; reserved entries (e.g. Find) ride along
  // in `catalog` solely so `findConflict` can flag collisions against them.
  const sections = useMemo(
    () =>
      scopeSections(t)
        .map((section) => ({
          ...section,
          commands: catalog.filter(
            (entry) => entry.rebindable && entry.scope === section.scope,
          ),
        }))
        .filter((section) => section.commands.length > 0),
    [catalog, t],
  );

  return (
    <div className="space-y-4">
      {conflict !== null && (
        <Notice tone="warning">
          {t("shortcutsSections.conflictNoticePrefix", {
            label: conflict.label,
          })}{" "}
          {recordingKey !== null
            ? t("shortcutsSections.conflictRecordingHint")
            : t("shortcutsSections.conflictResetHint")}
        </Notice>
      )}

      {sections.map((section) => (
        <Card key={section.scope} bordered>
          <div className="mb-2">
            <div className="text-body-medium-emphasised text-[var(--content-default)]">
              {section.title}
            </div>
            <div className="text-body-small-default text-[var(--content-tertiary)]">
              {section.description}
            </div>
          </div>
          <div className="divide-y divide-[var(--border-base)]">
            {section.commands.map((hotkey) => (
              <ShortcutRow
                key={hotkey.key}
                hotkey={hotkey}
                recording={recordingKey === hotkey.key}
                conflictLabel={
                  conflict !== null && conflict.key === hotkey.key
                    ? conflict.label
                    : null
                }
                onStartRecording={() => startRecording(hotkey.key)}
                onCancelRecording={stopRecording}
                onReset={() => resetHotkey(hotkey.key)}
                onRemove={() => removeHotkey(hotkey.key)}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
