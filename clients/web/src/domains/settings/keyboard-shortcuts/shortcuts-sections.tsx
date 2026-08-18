import { RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getHotkeys,
  onHotkeysChange,
  setHotkey,
  type ResolvedHotkey,
} from "@/runtime/hotkeys";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { ShortcutKeys } from "@vellumai/design-library/components/shortcut-keys";

import {
  eventToAccelerator,
  findConflict,
} from "@/domains/settings/keyboard-shortcuts/electron-accelerator";

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

interface ShortcutRowProps {
  hotkey: ResolvedHotkey;
  recording: boolean;
  conflictLabel: string | null;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onReset: () => void;
  onRemove: () => void;
}

/**
 * One rebindable command: its current binding plus record / reset / remove
 * controls. While recording, a keydown anywhere is captured by the page and
 * turned into an accelerator; this row just reflects the recording state and
 * surfaces a conflict message inline.
 */
function ShortcutRow({
  hotkey,
  recording,
  conflictLabel,
  onStartRecording,
  onCancelRecording,
  onReset,
  onRemove,
}: ShortcutRowProps) {
  const { t } = useTranslation("settings");
  const isDisabled = hotkey.accelerator === "";
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
        {recording ? (
          <span className="text-body-small-default text-[var(--content-secondary)]">
            {t("shortcutsSections.recordingHint")}
          </span>
        ) : isDisabled ? (
          <span className="text-body-small-default italic text-[var(--content-disabled)]">
            {t("shortcutsSections.disabled")}
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
          disabled={isDisabled}
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
  const [catalog, setCatalog] = useState<ResolvedHotkey[]>([]);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    key: string;
    label: string;
  } | null>(null);

  const refresh = useCallback(() => {
    void getHotkeys().then(setCatalog);
  }, []);

  useEffect(() => {
    refresh();
    return onHotkeysChange(setCatalog);
  }, [refresh]);

  const stopRecording = useCallback(() => {
    setRecordingKey(null);
    setConflict(null);
  }, []);

  useEffect(() => {
    if (recordingKey === null) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        stopRecording();
        return;
      }

      const accelerator = eventToAccelerator(event);
      if (accelerator === null) {
        return;
      }

      const clash = findConflict(catalog, recordingKey, accelerator);
      if (clash !== null) {
        setConflict({ key: recordingKey, label: clash.label });
        return;
      }

      void setHotkey(recordingKey, accelerator).then(refresh);
      stopRecording();
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [recordingKey, catalog, refresh, stopRecording]);

  const startRecording = useCallback((key: string) => {
    setConflict(null);
    setRecordingKey(key);
  }, []);

  const resetHotkey = useCallback(
    (key: string) => {
      // Reverting to the compiled default is still a write, so it must clear the
      // same conflict bar as recording: a default freed by rebinding this
      // command may have since been claimed by another, and writing `null`
      // blindly would resurrect that accelerator and shadow the other binding.
      const fallback =
        catalog.find((entry) => entry.key === key)?.defaultAccelerator ?? "";
      const clash = findConflict(catalog, key, fallback);
      if (clash !== null) {
        setRecordingKey(null);
        setConflict({ key, label: clash.label });
        return;
      }
      stopRecording();
      void setHotkey(key, null).then(refresh);
    },
    [catalog, refresh, stopRecording],
  );

  const removeHotkey = useCallback(
    (key: string) => {
      stopRecording();
      void setHotkey(key, "").then(refresh);
    },
    [refresh, stopRecording],
  );

  // Only rebindable commands get a row; reserved entries (e.g. Find) ride along
  // in `catalog` solely so `findConflict` can flag collisions against them.
  const sections = useMemo(
    () =>
      scopeSections(t).map((section) => ({
        ...section,
        commands: catalog.filter(
          (entry) => entry.rebindable && entry.scope === section.scope,
        ),
      })).filter((section) => section.commands.length > 0),
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
